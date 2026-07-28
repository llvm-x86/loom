import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBlobsDir, isEnoent, logger, parseJsonlLenient } from "@oh-my-pi/pi-utils";
import {
	BlobStore,
	isBlobRef,
	parseBlobRef,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
} from "./blob-store";
import { buildSessionContext } from "./session-context";
import {
	type CompactionEntry,
	type FileEntry,
	type RawFileEntry,
	SESSION_TITLE_SLOT_BYTES,
	type SessionEntry,
	type SessionHeader,
	type SessionTitleSlotEntry,
} from "./session-entries";
import { migrateToCurrentVersion } from "./session-migrations";
import { isImageBlock, isImageDataPayload } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const ELIDED_COMPACTION_SUMMARY = "[Superseded compaction summary elided during session load]";
const ELIDED_COMPACTION_SHORT_SUMMARY = "Superseded compaction elided";

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

function foldTitleSlot(entries: FileEntry[], slot: SessionTitleUpdate | undefined): FileEntry[] {
	if (!slot || entries.length === 0) return entries;
	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string") return entries;
	if (slot.title && slot.title.length > 0) {
		header.title = slot.title;
	} else {
		delete header.title;
	}
	if (slot.source) {
		header.titleSource = slot.source;
	} else {
		delete header.titleSource;
	}
	return entries;
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(content: string): {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
} {
	const { body, slot } = splitTitleSlot(content);
	const entries = parseJsonlLenient<RawFileEntry>(body) as FileEntry[];
	return { entries: foldTitleSlot(entries, slot), titleSlot: slot };
}

function elideCompactionSummary(entry: CompactionEntry | undefined): boolean {
	if (!entry) return false;
	if (
		entry.summary === ELIDED_COMPACTION_SUMMARY &&
		entry.shortSummary === ELIDED_COMPACTION_SHORT_SUMMARY &&
		entry.preserveData === undefined
	) {
		return false;
	}
	entry.summary = ELIDED_COMPACTION_SUMMARY;
	entry.shortSummary = ELIDED_COMPACTION_SHORT_SUMMARY;
	entry.preserveData = undefined;
	return true;
}

function collectActiveBranchIds(entries: FileEntry[]): Set<string> {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		const id = (entry as SessionEntry).id;
		if (typeof id === "string") byId.set(id, entry as SessionEntry);
	}
	const branchIds = new Set<string>();
	let cursor = entries[entries.length - 1] as SessionEntry | undefined;
	while (cursor && typeof cursor.id === "string" && !branchIds.has(cursor.id)) {
		branchIds.add(cursor.id);
		const parentId = cursor.parentId;
		cursor = parentId ? byId.get(parentId) : undefined;
	}
	return branchIds;
}

function elideSupersededCompactionEntries(entries: FileEntry[]): void {
	const branchIds = collectActiveBranchIds(entries);
	let previousCompaction: CompactionEntry | undefined;
	for (const entry of entries) {
		if (entry.type !== "compaction") continue;
		if (!branchIds.has(entry.id)) continue;
		elideCompactionSummary(previousCompaction);
		previousCompaction = entry;
	}
}

/** Exported for testing — the ≥8MiB streaming path (works on any file size). */
export async function loadEntriesFromFileStream(filePath: string): Promise<{
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
}> {
	const entries: FileEntry[] = [];
	let titleSlot: SessionTitleUpdate | undefined;
	let sawFirstLine = false;
	// Byte buffer (NOT a decoded string): multibyte UTF-8 sequences that straddle
	// a stream-chunk boundary stay intact, and Bun.JSONL.parseChunk accepts typed
	// arrays directly. Only the unconsumed remainder is held (≤ one record + a
	// chunk), so the ≥8MiB memory guard is preserved (the file is never fully
	// loaded into memory).
	let buffer: Uint8Array = new Uint8Array();
	const decoder = new TextDecoder();

	const drain = () => {
		while (buffer.length > 0) {
			const { values, error, read, done } = Bun.JSONL.parseChunk(buffer);
			if (values.length > 0) {
				for (const value of values) entries.push(value as FileEntry);
			}
			if (error) {
				// Malformed record: skip past the next newline and continue.
				const nextNewline = buffer.indexOf(0x0a, read);
				if (nextNewline === -1) break; // rest of the bad line not yet received
				buffer = buffer.subarray(nextNewline + 1);
				continue;
			}
			if (read === 0) break; // incomplete record awaiting more data
			buffer = buffer.subarray(read);
			if (done) {
				buffer = new Uint8Array();
				break;
			}
		}
	};

	try {
		for await (const chunk of Bun.file(filePath).stream()) {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			// The optional fixed-width title slot is a physical first line that is
			// NOT JSON; peel it before the parser would (correctly) reject it. The
			// first line ends at a '\n' byte, so it is a complete UTF-8 sequence and
			// safe to decode. A non-slot first line is a real entry and is left for
			// the parser; a blank first line is left for the parser to skip.
			if (!sawFirstLine) {
				const newline = buffer.indexOf(0x0a);
				if (newline !== -1) {
					sawFirstLine = true;
					const firstLine = decoder.decode(buffer.subarray(0, newline)).trim();
					if (firstLine) {
						const slot = parseTitleSlotLine(firstLine);
						if (slot) {
							titleSlot = titleUpdateFromSlot(slot);
							buffer = buffer.subarray(newline + 1);
						}
					}
				}
			}
			drain();
		}
		// A trailing record without a final newline: terminate it so the parser
		// can complete it (readline yielded it; parseChunk needs the delimiter).
		if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
			buffer = Buffer.concat([buffer, new Uint8Array([0x0a])]);
		}
		drain();
	} catch (err) {
		if (isEnoent(err)) return { entries: [], titleSlot: undefined };
		throw err;
	}

	return { entries: foldTitleSlot(entries, titleSlot), titleSlot };
}

/** Read only the fixed-size head window to detect a physical title slot. */
export async function readTitleSlotFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionTitleSlotEntry | undefined> {
	let head: string;
	try {
		[head] = await storage.readTextSlices(filePath, SESSION_TITLE_SLOT_BYTES, 0);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	const newlineIndex = head.indexOf("\n");
	if (newlineIndex < 0) return undefined;
	return parseTitleSlotLine(head.slice(0, newlineIndex));
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}

/** Exported for testing */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<FileEntry[]> {
	let loaded: { entries: FileEntry[]; titleSlot: SessionTitleUpdate | undefined };
	try {
		const stat = storage.statSync(filePath);
		loaded =
			storage instanceof FileSessionStorage && stat.size >= STREAM_LOAD_THRESHOLD_BYTES
				? await loadEntriesFromFileStream(filePath)
				: parseSessionContent(await storage.readText(filePath));
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const { entries } = loaded;
	elideSupersededCompactionEntries(entries);

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string") {
		return [];
	}

	return entries;
}

/**
 * Resolve blob references in loaded entries, restoring both session image blocks and persisted
 * provider image URLs back to the inline data expected by downstream transports. Mutates entries in place.
 */
function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

function shouldResolveImagePayload(value: unknown, key: string | undefined): value is { data: string } {
	if (!isImageDataPayload(value) || !isBlobRef(value.data)) return false;
	return (key === "content" && isImageBlock(value)) || key === "images";
}

async function resolvePersistedBlobRefs(value: unknown, blobStore: BlobStore, key?: string): Promise<void> {
	if (shouldResolveImagePayload(value, key)) {
		value.data = await resolveImageData(blobStore, value.data);
		return;
	}

	if (Array.isArray(value)) {
		await Promise.all(value.map(item => resolvePersistedBlobRefs(item, blobStore, key)));
		return;
	}

	if (typeof value !== "object" || value === null) return;
	if (
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string" &&
		isBlobRef(value.result)
	) {
		value.result = await resolveImageData(blobStore, value.result);
	}

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		value.image_url = await resolveImageDataUrl(blobStore, value.image_url);
	}

	await Promise.all(
		Object.entries(value).map(([childKey, item]) => resolvePersistedBlobRefs(item, blobStore, childKey)),
	);
}

/**
 * Cheap synchronous precheck: does this value's tree contain any `blob:sha256:` string?
 * Early-exits on the first hit and allocates no promises, so blob-free entries skip the
 * async {@link resolvePersistedBlobRefs} descent entirely. Conservative — a blob ref in a
 * non-resolved position still returns true, which only costs an extra (no-op) walk.
 */
function containsBlobRef(value: unknown): boolean {
	if (typeof value === "string") return isBlobRef(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (containsBlobRef(item)) return true;
		}
		return false;
	}
	if (typeof value !== "object" || value === null) return false;
	for (const key in value) {
		if (containsBlobRef((value as Record<string, unknown>)[key])) return true;
	}
	return false;
}

export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	const pending: Promise<void>[] = [];
	// Interleave precheck + initiation per entry so a positive entry begins resolution at the same
	// relative point as the old filter+map schedule (no scan-all-first pass that could observe a
	// later entry before an earlier resolution mutates it).
	for (const entry of entries) {
		if (entry.type === "session") continue;
		if (!containsBlobRef(entry)) continue;
		pending.push(resolvePersistedBlobRefs(entry, blobStore));
	}
	await Promise.all(pending);
}

/**
 * Synchronous counterpart of `resolveImageDataUrl`, needed because a property
 * getter cannot await. Mirrors it exactly, including the missing-blob warning
 * and the "keep the ref string" degradation.
 */
function resolveImageDataUrlSync(blobStore: BlobStore, data: string): string {
	const hash = parseBlobRef(data);
	if (!hash) return data;

	const buffer = blobStore.getSync(hash);
	if (!buffer) {
		logger.warn("Blob not found for persisted image data URL", { hash });
		return data;
	}
	return buffer.toString("utf8");
}

/**
 * Replace a `blob:sha256:` ref with an accessor that reads the blob on first
 * access and then collapses back into a plain data property, so a payload
 * nothing ever touches costs a 76-character ref instead of its inflated inline
 * form (base64 is 4/3 of the bytes on disk).
 *
 * Enumerable and configurable, so `JSON.stringify`, object spread, and
 * `structuredClone` behave exactly as they did against an eagerly-resolved
 * value — they simply materialize it at that point. Assignment is supported
 * and drops the accessor, matching a plain field.
 */
function defineLazyBlobRef(
	target: object,
	key: string,
	ref: string,
	blobStore: BlobStore,
	form: "base64" | "dataUrl",
): void {
	const settle = (value: string): string => {
		Object.defineProperty(target, key, { configurable: true, enumerable: true, writable: true, value });
		return value;
	};
	Object.defineProperty(target, key, {
		configurable: true,
		enumerable: true,
		get: (): string =>
			settle(form === "base64" ? resolveImageDataSync(blobStore, ref) : resolveImageDataUrlSync(blobStore, ref)),
		set: (value: string): void => {
			settle(value);
		},
	});
}

/** Install lazy accessors over the same sites {@link resolvePersistedBlobRefs} resolves eagerly. */
function installLazyBlobRefs(value: unknown, blobStore: BlobStore, key?: string): void {
	if (shouldResolveImagePayload(value, key)) {
		defineLazyBlobRef(value, "data", value.data, blobStore, "base64");
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) installLazyBlobRefs(item, blobStore, key);
		return;
	}

	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;

	let deferredResult = false;
	if (record.type === "image_generation_call" && typeof record.result === "string" && isBlobRef(record.result)) {
		defineLazyBlobRef(record, "result", record.result, blobStore, "base64");
		deferredResult = true;
	}
	const imageUrl = record.image_url;
	let deferredImageUrl = false;
	if (typeof imageUrl === "string" && isBlobRef(imageUrl)) {
		defineLazyBlobRef(record, "image_url", imageUrl, blobStore, "dataUrl");
		deferredImageUrl = true;
	}

	for (const childKey in record) {
		// Never read back an accessor this pass just installed: that would
		// materialize the exact bytes being deferred.
		if (deferredResult && childKey === "result") continue;
		if (deferredImageUrl && childKey === "image_url") continue;
		installLazyBlobRefs(record[childKey], blobStore, childKey);
	}
}

/**
 * Lazy counterpart of {@link resolveBlobRefsInEntries}: same sites, same
 * resolved values, but each payload is read from the blob store on first access
 * instead of all of them being materialized at load.
 *
 * Blob refs are stable content-addressed paths, so deferring the read changes
 * nothing an eager pass guaranteed — a blob that disappears between load and
 * access degrades to the ref string with a warning, which is exactly what the
 * eager pass does for a blob already missing at load. Entries that are never
 * turned into provider messages (other branches, pre-compaction history) never
 * pay for their images at all.
 *
 * Synchronous: a property getter cannot await, and blob reads are single
 * `readFileSync` calls against the same page cache the eager pass warmed.
 */
export function installLazyBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): void {
	for (const entry of entries) {
		if (entry.type === "session") continue;
		if (!containsBlobRef(entry)) continue;
		installLazyBlobRefs(entry, blobStore);
	}
}

/**
 * Read-only message view of a session file: load entries, migrate to the
 * current version, arm lazy blob rehydration, and build the context along the
 * persisted leaf path (last entry). Does NOT create a writer or take the
 * session lock — safe to call against a file another session is writing.
 */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	installLazyBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	return buildSessionContext(sessionEntries).messages;
}
