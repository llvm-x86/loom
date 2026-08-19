import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Background-maintained memory tree.
 *
 * The mnemopi bank (SQLite) is the source of truth; this module renders it as
 * an agent-readable file tree that ONLY the background memory system writes.
 * `renderMemoryTree` itself projects ONE bank into whatever directory it is
 * handed (used directly by tests); callers that hold multiple banks route
 * through `bankTreeDir` so every bank gets its own subdirectory and none can
 * clobber another's entry points:
 *
 *   <treeRoot>/
 *     MEMORY.md                             cross-project index: one row per bank dir
 *     <bank>/MEMORY.md                       per-bank entry point: subtree rollup
 *     <bank>/<subtree>/MEMORY.md             entry point: leaf headers for the subtree
 *     <bank>/<subtree>/<slug>.md             leaf (YAML-lite header + body)
 *     <bank>/archive/<subtree>/<slug>.md     leaves whose bank row is archived
 *
 * Working agents never write here — they read with their normal file tools and
 * request mutations through the single `memory` tool. Reading/grepping another
 * project's `<bank>/` directory is how an agent pulls context across projects.
 * Every render is a pure projection of the bank, so the tree is disposable:
 * delete it and the next pass re-materialises it fully.
 *
 * Reconcile rules (idempotent, safe to run on every pass):
 *  - a leaf whose body differs from its bank row AND whose file mtime is
 *    newer than the row is an external hand-edit: the body is ADOPTED back
 *    into the bank (body wins, metadata stays background-owned);
 *  - stale leaves (slug no longer in the bank) are removed;
 *  - archived rows render under `archive/` with `status: archived`;
 *  - `renderMemoryTreeIndex` rescans `treeRoot` for bank directories (marker
 *    on their own MEMORY.md, not directory name) and rewrites the root index.
 */

export const MEMORY_TREE_ENTRY_FILE = "MEMORY.md";
export const MEMORY_TREE_ARCHIVE_DIR = "archive";

/**
 * `<treeRoot>/<bank>` — the canonical per-bank directory. Guards `bank`
 * against traversal/separators before it becomes a path segment; returns
 * undefined (never a raw-root fallback) for anything that fails the guard —
 * silently rendering there would collide every bank's projection into one
 * pile. Shared by both render entry points (in-session and sync-context) so
 * there is exactly one place that knows the `<treeRoot>/<bank>` convention.
 */
export const BANK_ID_PATH_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function bankTreeDir(treeRoot: string, bank: string): string | undefined {
	if (!BANK_ID_PATH_RE.test(bank)) return undefined;
	return path.join(treeRoot, bank);
}

export interface MemoryTreeRow {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	updated: string;
	importance: number | null;
	memoryType: string | null;
	veracity: string | null;
	metadata: Record<string, unknown>;
	bank: string;
	/** Which table the id resolved from — decides which SQL adopt targets. */
	store: "working" | "episodic";
	archived: boolean;
	/** Timestamp that archived this row, if archival was time-based. */
	validUntil: string | null;
	subtree: string;
}

export interface RenderMemoryTreeInput {
	memory: Mnemopi;
	bank: string;
	treeRoot: string;
	/** Per-leaf content cap in characters. Defaults to 4096. */
	leafCharCap?: number;
	/** Per-subtree entry-point row cap. Defaults to 200. */
	entryRows?: number;
	/** Purge archived rows whose `valid_until` is older than this many days. Defaults to 90; 0 disables GC. */
	archiveGcDays?: number;
}

export interface RenderMemoryTreeResult {
	leaves: number;
	written: number;
	archived: number;
	adopted: number;
	removedStale: number;
	/** Bank rows garbage-collected (archived beyond the horizon) this pass. */
	gc: number;
}

const TREE_LEAF_MIN_CHARS = 256;
const TREE_ENTRY_SUMMARY_CHARS = 140;
const TREE_ENTRY_ROWS = 200;
const TREE_ARCHIVE_GC_DAYS = 90;
const TREE_WRITE_LOG_KEEP = 500;

const ROW_QUERY = `
	SELECT id, content, source, timestamp,
	       COALESCE(created_at, timestamp, '') AS updated,
	       importance, memory_type, veracity,
	       COALESCE(metadata_json, '{}') AS metadata_json,
	       valid_until, superseded_by
	FROM working_memory
	UNION ALL
	SELECT id, content, source, timestamp,
	       COALESCE(created_at, timestamp, '') AS updated,
	       importance, memory_type, veracity,
	       COALESCE(metadata_json, '{}') AS metadata_json,
	       valid_until, superseded_by
	FROM episodic_memory
`;

interface RawTreeRow {
	id: string;
	content: string;
	source: string | null;
	timestamp: string | null;
	updated: string;
	importance: number | null;
	memory_type: string | null;
	veracity: string | null;
	metadata_json: string;
	valid_until: string | null;
	superseded_by: string | null;
}

/** Read every active + archived row the bank holds, in bank order (working first). */
export function queryTreeRows(memory: Mnemopi, bank: string, now: Date = new Date()): MemoryTreeRow[] {
	const raw = memory.db.query(ROW_QUERY).all() as RawTreeRow[];
	const rows: MemoryTreeRow[] = [];
	const seen = new Set<string>();
	for (const row of raw) {
		if (seen.has(row.id)) continue; // promoted rows appear in both tables
		seen.add(row.id);
		let metadata: Record<string, unknown> = {};
		try {
			metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
		} catch {
			metadata = {};
		}
		const store = rowsWorkingFirst(memory, row);
		const archived =
			row.superseded_by !== null ||
			(row.valid_until !== null && row.valid_until !== "" && new Date(row.valid_until).getTime() < now.getTime());
		rows.push({
			id: row.id,
			content: typeof row.content === "string" ? row.content : "",
			source: row.source,
			timestamp: row.timestamp,
			updated: row.updated || row.timestamp || "",
			importance: typeof row.importance === "number" ? row.importance : null,
			memoryType: row.memory_type,
			veracity: row.veracity,
			metadata,
			bank,
			store,
			archived,
			validUntil: row.valid_until,
			subtree: deriveSubtree(metadata, bank),
		});
	}
	return rows;
}

/** UNION loses the source table; re-resolve store by probing working_memory first. */
function rowsWorkingFirst(memory: Mnemopi, row: RawTreeRow): "working" | "episodic" {
	const hit = memory.db.prepare("SELECT 1 AS found FROM working_memory WHERE id = ? LIMIT 1").get(row.id) as {
		found?: number;
	} | null;
	return hit ? "working" : "episodic";
}

/**
 * One backdrop fallback: a memory without `metadata.subtree` or `metadata.cwd`
 * lands in `misc` instead of a per-project tree, so nothing is ever lost.
 */
function deriveSubtree(metadata: Record<string, unknown>, bank: string): string {
	const explicit = typeof metadata.subtree === "string" ? metadata.subtree : undefined;
	if (explicit !== undefined && explicit.trim() !== "") return sanitizeSubtree(explicit);
	const cwd = typeof metadata.cwd === "string" ? metadata.cwd : undefined;
	if (cwd !== undefined && cwd.trim() !== "") return `projects/${sanitizeSubtree(path.basename(cwd))}`;
	return sanitizeSubtree(bank) || "misc";
}

/** Allow a short nested path (e.g. `projects/agent-chat`) but no traversal. */
export function sanitizeSubtree(value: string): string {
	const segments = value
		.split("/")
		.map(segment => segment.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""))
		.filter(segment => segment !== "" && segment !== "." && segment !== "..");
	return segments.slice(0, 4).join("/");
}

function slugForId(id: string): string {
	const cleaned = id.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	if (cleaned !== "" && cleaned.length <= 96) return cleaned;
	const hash = stableHash(id).toString(36).slice(0, 10);
	return cleaned !== "" ? `${cleaned.slice(0, 80)}-${hash}` : `mem-${hash}`;
}

function stableHash(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (hash * 31 + value.charCodeAt(i)) | 0;
	}
	return Math.abs(hash);
}

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function summaryOf(content: string, cap: number): string {
	const collapsed = content.replace(/\s+/g, " ").trim();
	return collapsed.length > cap ? `${collapsed.slice(0, cap)}…` : collapsed;
}

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n")) return text;
	const end = text.indexOf("\n---\n", 4);
	return end === -1 ? text : text.slice(end + 5);
}

function tagsFor(row: MemoryTreeRow): string[] {
	const tags: string[] = [];
	if (row.memoryType && row.memoryType !== "unknown") tags.push(row.memoryType);
	if (row.veracity && row.veracity !== "unknown") tags.push(row.veracity);
	const metadataTags = row.metadata.tags;
	if (Array.isArray(metadataTags)) {
		for (const tag of metadataTags) {
			if (typeof tag !== "string" || tag.trim() === "") continue;
			const cleaned = tag.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
			if (cleaned !== "") tags.push(cleaned);
		}
	}
	const tool = row.metadata.tool;
	if (typeof tool === "string" && tool !== "") tags.push(`via:${tool}`);
	return [...new Set(tags)].slice(0, 8);
}

function renderLeafBody(row: MemoryTreeRow, leafCharCap: number): string {
	const cap = Math.max(TREE_LEAF_MIN_CHARS, leafCharCap);
	const body = row.content.length > cap ? row.content.slice(0, cap) : row.content;
	const tags = tagsFor(row);
	const connections = row.metadata.connections;
	const connectionList = Array.isArray(connections)
		? connections
				.filter((item): item is string => typeof item === "string" && item.trim() !== "")
				.map(item => item.trim())
				.slice(0, 12)
		: [];
	const header = [
		"---",
		`title: ${escapeCell(summaryOf(row.content, 80))}`,
		`id: ${row.id}`,
		`subtree: ${row.subtree}`,
		`status: ${row.archived ? "archived" : "active"}`,
		`tags: ${tags.length > 0 ? `[${tags.join(", ")}]` : "[]"}`,
		`source: ${row.source ?? "unknown"}`,
		`updated: ${row.updated}`,
		`importance: ${row.importance ?? 0.5}`,
		`connections: ${connectionList.length > 0 ? `[${connectionList.join(", ")}]` : "[]"}`,
		"---",
		"",
		body,
		"",
	].join("\n");
	return header;
}

function renderSubtreeEntry(
	subtree: string,
	leaves: readonly MemoryTreeRow[],
	archivedCount: number,
	overflow = 0,
): string {
	const lines = leaves.map(row => {
		const slug = slugForId(row.id);
		return `| ${slug} | ${escapeCell(summaryOf(row.content, TREE_ENTRY_SUMMARY_CHARS))} | ${escapeCell(
			tagsFor(row).join(", "),
		)} | active | ${escapeCell(row.updated.slice(0, 19))} |`;
	});
	const overflowLines =
		overflow > 0 ? [`${overflow} older leaf(ren) not listed (entry point capped at ${leaves.length} rows).`, ""] : [];
	return [
		`# Memory: ${subtree}`,
		"",
		"The background memory system maintains this entry point and the leaves below it.",
		"Read it first, then follow leaves whose summary matches the task. Do not edit —",
		"the next reconcile pass overwrites this file.",
		"",
		"| leaf | summary | tags | status | updated |",
		"| --- | --- | --- | --- | --- |",
		...lines,
		"",
		`${leaves.length} leaf(ren) active, ${archivedCount} archived under \`archive/${subtree}/\`.`,
		...overflowLines,
	].join("\n");
}

/**
 * Title carries the "this dir is a rendered bank" marker that
 * `renderMemoryTreeIndex` scans for — must stay distinct from both the
 * cross-project index title (`# Memory index`) and the subtree entry title
 * (`# Memory: <subtree>`) so the three file kinds can never be confused.
 */
export const BANK_ROOT_ENTRY_MARKER = "# Memory tree:";

function renderRootEntry(
	treeRoot: string,
	bank: string,
	subtrees: readonly { subtree: string; leaves: number; archived: number; updated: string }[],
): string {
	const lines = subtrees.map(entry => {
		return `| ${escapeCell(entry.subtree)} | ${entry.leaves} | ${entry.archived} | ${escapeCell(
			entry.updated.slice(0, 19),
		)} |`;
	});
	return [
		`${BANK_ROOT_ENTRY_MARKER} ${bank}`,
		"",
		`Auto-generated entry point for bank \`${bank}\`'s memory tree at \`${treeRoot}\`.`,
		"Every file under this root is written ONLY by the background memory system; working",
		"agents read with their normal file tools and request changes through the single",
		"`memory` tool. Read this file first, then a subtree's MEMORY.md, then follow leaves.",
		`Other projects' memory lives in sibling directories — see \`../${MEMORY_TREE_ENTRY_FILE}\``,
		"for the cross-project index.",
		"",
		"| subtree | leaves | archived | updated |",
		"| --- | --- | --- | --- |",
		...lines,
		"",
	].join("\n");
}

async function atomicWrite(dest: string, content: string): Promise<void> {
	const tmp = `${dest}.tmp-${process.pid}`;
	try {
		await writeFile(tmp, content, "utf8");
		await rename(tmp, dest);
	} catch (error) {
		// A write interrupted mid-flight (crash, OOM-kill) must not leave a
		// `MEMORY.md.tmp-<pid>` orphan sitting in the tree forever.
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

function repoSlugHint(bank: string): string | undefined {
	// Repo-keyed banks ARE the sanitized `owner/repo` slug (sync-context.ts);
	// synthetic cwd-derived banks are `<basename>-<base36 Bun.hash>`
	// (limitBankName in config.ts) — a long trailing base36 run is the tell.
	// Best-effort display hint only, never used for path safety.
	if (bank === "default") return undefined;
	if (/-[0-9a-z]{10,16}$/.test(bank)) return undefined;
	return bank;
}

async function countActiveLeaves(bankDir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await readdir(bankDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let count = 0;
	for (const entry of entries) {
		if (entry.name === MEMORY_TREE_ARCHIVE_DIR) continue; // archived leaves aren't "active"
		const full = path.join(bankDir, entry.name);
		if (entry.isDirectory()) {
			count += await countActiveLeaves(full);
		} else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== MEMORY_TREE_ENTRY_FILE) {
			count += 1;
		}
	}
	return count;
}

function renderBankIndex(treeRoot: string, rows: readonly { bank: string; leaves: number; updated: string }[]): string {
	const lines = rows.map(row => {
		return `| ${escapeCell(row.bank)} | ${row.leaves} | ${escapeCell(row.updated.slice(0, 19))} | ${escapeCell(
			repoSlugHint(row.bank) ?? "-",
		)} |`;
	});
	return [
		"# Memory index",
		"",
		`Cross-project entry point for the memory tree at \`${treeRoot}\`. Each row is a separate`,
		"project's memory bank, rendered by the background memory system into its own directory —",
		"this file only lists banks, it is NOT itself a project's tree. Read `<bank>/MEMORY.md`",
		"for that project's subtree rollup, then follow leaves the same as your own memory. You",
		"may read/grep another project's directory directly to pull context from it; nothing",
		"under this root is scoped to the current session.",
		"",
		"| bank | leaves | updated | repo |",
		"| --- | --- | --- | --- |",
		...lines,
		"",
	].join("\n");
}

/**
 * Scan `treeRoot` for rendered bank directories and (re)write the
 * cross-project index at `<treeRoot>/MEMORY.md`. Filesystem-driven, not
 * session-driven: a bank this session never opened still shows up as long as
 * some process rendered it. A directory only counts as a bank if its own
 * `MEMORY.md` carries the per-bank marker (`# Memory tree: <bank>`) —
 * legacy flat subtree dirs from the pre-per-bank layout (`concepts/`,
 * `projects/`, ...) have a *subtree* MEMORY.md (`# Memory: <subtree>`)
 * instead and must never be mistaken for a bank; `archive/` and stray
 * `MEMORY.md.tmp-*` files are likewise never listed.
 */
export async function renderMemoryTreeIndex(treeRoot: string): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(treeRoot, { withFileTypes: true });
	} catch {
		return; // nothing rendered under this root yet
	}
	const rows: { bank: string; leaves: number; updated: string }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === MEMORY_TREE_ARCHIVE_DIR) continue;
		const bankDir = path.join(treeRoot, entry.name);
		const entryFile = path.join(bankDir, MEMORY_TREE_ENTRY_FILE);
		const content = await readFile(entryFile, "utf8").catch(() => null);
		if (content === null || !content.startsWith(`${BANK_ROOT_ENTRY_MARKER} `)) continue;
		const [leaves, updated] = await Promise.all([
			countActiveLeaves(bankDir),
			stat(entryFile)
				.then(s => s.mtime.toISOString())
				.catch(() => ""),
		]);
		rows.push({ bank: entry.name, leaves, updated });
	}
	rows.sort((a, b) => (a.bank < b.bank ? -1 : 1));
	await atomicWrite(path.join(treeRoot, MEMORY_TREE_ENTRY_FILE), renderBankIndex(treeRoot, rows));
}

/**
 * Render one bank as a file-tree projection. Idempotent — safe to call on
 * every reconcile pass. Returns what changed in this pass.
 */
export async function renderMemoryTree(input: RenderMemoryTreeInput): Promise<RenderMemoryTreeResult> {
	const { memory, bank, treeRoot } = input;
	const nowMs = Date.now();
	const leafCharCap = Math.max(TREE_LEAF_MIN_CHARS, input.leafCharCap ?? 4096);
	const entryRows = Math.max(1, input.entryRows ?? TREE_ENTRY_ROWS);
	const archiveGcDays = Math.max(0, input.archiveGcDays ?? TREE_ARCHIVE_GC_DAYS);
	const gcHorizonMs = nowMs - archiveGcDays * 86_400_000;
	const rows = queryTreeRows(memory, bank);
	const result: RenderMemoryTreeResult = {
		leaves: rows.length,
		written: 0,
		archived: 0,
		adopted: 0,
		removedStale: 0,
		gc: 0,
	};

	const bySubtree = new Map<string, { active: Map<string, MemoryTreeRow>; archived: Map<string, MemoryTreeRow> }>();
	for (const row of rows) {
		let group = bySubtree.get(row.subtree);
		if (!group) {
			group = { active: new Map(), archived: new Map() };
			bySubtree.set(row.subtree, group);
		}
		(row.archived ? group.archived : group.active).set(slugForId(row.id), row);
	}
	const archivedKeptBySubtree = new Map<string, number>();

	for (const [subtree, group] of bySubtree) {
		const activeDir = path.join(treeRoot, subtree);
		const archiveDir = path.join(treeRoot, MEMORY_TREE_ARCHIVE_DIR, subtree);
		await mkdir(activeDir, { recursive: true });
		await mkdir(archiveDir, { recursive: true });

		const activeSlugs = new Set<string>();
		for (const [slug, row] of group.active) {
			activeSlugs.add(slug);
			const dest = path.join(activeDir, `${slug}.md`);
			const rendered = renderLeafBody(row, leafCharCap);
			const existing = await readFile(dest, "utf8").catch(() => null);
			if (existing !== null && stripFrontmatter(existing) !== stripFrontmatter(rendered)) {
				const mtimeMs = (await stat(dest)).mtimeMs;
				const rowUpdatedMs = Date.parse(row.updated);
				if (Number.isFinite(rowUpdatedMs) && mtimeMs > rowUpdatedMs) {
					// External hand-edit: adopt the body into the bank (metadata stays
					// background-owned), then keep the edited body in this pass.
					const adoptedBody = stripFrontmatter(existing).trim();
					if (adoptedBody !== "") {
						if (adoptRowContent(memory, row, adoptedBody)) {
							result.adopted += 1;
							await atomicWrite(dest, renderLeafBody({ ...row, content: adoptedBody }, leafCharCap));
							continue;
						}
					}
				}
			}
			await atomicWrite(dest, rendered);
			result.written += 1;
		}

		const keptArchived: MemoryTreeRow[] = [];
		const archivedKeptSlugs = new Set<string>();
		for (const [slug, row] of group.archived) {
			const expiryMs = row.validUntil !== null ? Date.parse(row.validUntil) : Number.NaN;
			if (archiveGcDays > 0 && Number.isFinite(expiryMs) && expiryMs < gcHorizonMs && deleteRow(memory, row)) {
				// Lifecycle: archived → gc. The archive leaf is dropped by stale cleanup.
				result.gc += 1;
				continue;
			}
			archivedKeptSlugs.add(slug);
			keptArchived.push(row);
			await atomicWrite(path.join(archiveDir, `${slug}.md`), renderLeafBody(row, leafCharCap));
			result.archived += 1;
		}

		result.removedStale += await removeStaleLeaves(activeDir, activeSlugs);
		result.removedStale += await removeStaleLeaves(archiveDir, archivedKeptSlugs);
		const entryLeaves = [...group.active.values()]
			.sort((a, b) => (a.updated === b.updated ? (a.id < b.id ? -1 : 1) : a.updated < b.updated ? 1 : -1))
			.slice(0, entryRows);
		const overflow = group.active.size - entryLeaves.length;
		await atomicWrite(
			path.join(activeDir, MEMORY_TREE_ENTRY_FILE),
			renderSubtreeEntry(subtree, entryLeaves, keptArchived.length, overflow),
		);
		archivedKeptBySubtree.set(subtree, keptArchived.length);
	}

	const rollup = [...bySubtree.entries()]
		.map(([subtree, group]) => {
			const rows = [...group.active.values(), ...group.archived.values()];
			let updated = "";
			for (const row of rows) if (row.updated > updated) updated = row.updated;
			return {
				subtree,
				leaves: group.active.size,
				archived: archivedKeptBySubtree.get(subtree) ?? 0,
				updated,
			};
		})
		.sort((a, b) => (a.subtree < b.subtree ? -1 : 1));
	await atomicWrite(path.join(treeRoot, MEMORY_TREE_ENTRY_FILE), renderRootEntry(treeRoot, bank, rollup));
	appendTreeWriteLog(memory, bank, result);
	return result;
}

async function removeStaleLeaves(dir: string, keep: ReadonlySet<string>): Promise<number> {
	let removed = 0;
	let entries: string[] = [];
	try {
		entries = await readdir(dir);
	} catch {
		return 0; // dir may not exist yet
	}
	for (const name of entries) {
		if (!name.endsWith(".md") || name === MEMORY_TREE_ENTRY_FILE) continue;
		if (keep.has(name.slice(0, -3))) continue;
		try {
			await rm(path.join(dir, name));
			removed += 1;
		} catch {
			// best-effort stale cleanup
		}
	}
	return removed;
}

/** Adopt an externally-edited body back into the bank row. Returns true on success. */
function adoptRowContent(memory: Mnemopi, row: MemoryTreeRow, body: string): boolean {
	try {
		if (row.store === "working") return memory.update(row.id, body, null);
		const result = memory.db.prepare("UPDATE episodic_memory SET content = ? WHERE id = ?").run(body, row.id);
		return Number(result.changes) > 0;
	} catch (error) {
		logger.warn("Mnemopi: memory tree could not adopt hand-edited leaf", { id: row.id, error: String(error) });
		return false;
	}
}

/** Restore an archived row to active (clears validity/supersession). */
export function restoreMemoryRow(memory: Mnemopi, id: string): boolean {
	const db = memory.db;
	for (const table of ["working_memory", "episodic_memory"]) {
		const result = db.prepare(`UPDATE ${table} SET valid_until = NULL, superseded_by = NULL WHERE id = ?`).run(id);
		if (Number(result.changes) > 0) return true;
	}
	return false;
}

/** Substring lookup used by the `memory` tool for replace/remove/restore. */
export function findMemoryIdsBySubstring(memory: Mnemopi, needle: string, limit = 5): string[] {
	const trimmed = needle.trim();
	if (trimmed === "") return [];
	const escaped = trimmed.replace(/[\\%_]/g, match => `\\${match}`);
	const pattern = `%${escaped}%`;
	const db = memory.db;
	const ids: string[] = [];
	const tables: Array<"working_memory" | "episodic_memory"> = ["working_memory", "episodic_memory"];
	for (const table of tables) {
		const found = db
			.prepare(
				`SELECT id FROM ${table} WHERE content LIKE ? ESCAPE '\\' ORDER BY COALESCE(timestamp, '') DESC LIMIT ?`,
			)
			.all(pattern, Math.max(1, limit)) as { id: string }[];
		for (const row of found) {
			if (!ids.includes(row.id)) ids.push(row.id);
			if (ids.length >= limit) return ids;
		}
	}
	return ids;
}
/** Hard-delete a bank row (GC step of the queued→active⇄archived→gc lifecycle). */
function deleteRow(memory: Mnemopi, row: MemoryTreeRow): boolean {
	try {
		const table = row.store === "working" ? "working_memory" : "episodic_memory";
		const result = memory.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
		return Number(result.changes) > 0;
	} catch (error) {
		logger.warn("Mnemopi: memory tree GC could not delete row", { id: row.id, error: String(error) });
		return false;
	}
}

const TREE_WRITE_LOG_TABLE = `
	CREATE TABLE IF NOT EXISTS tree_write_log (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		at TEXT NOT NULL,
		bank TEXT NOT NULL,
		leaves INTEGER NOT NULL,
		written INTEGER NOT NULL,
		archived INTEGER NOT NULL,
		adopted INTEGER NOT NULL,
		removed_stale INTEGER NOT NULL,
		gc INTEGER NOT NULL
	)
`;

export interface TreeWriteLogEntry {
	at: string;
	bank: string;
	leaves: number;
	written: number;
	archived: number;
	adopted: number;
	removedStale: number;
	gc: number;
}

/**
 * Append one audit row per reconcile pass. The log is the background's record
 * of materialisation; the bank stays the source of truth, so "replay" after a
 * crash is just the next idempotent render, and the table only serves status
 * and debugging.
 */
function appendTreeWriteLog(memory: Mnemopi, bank: string, result: RenderMemoryTreeResult): void {
	try {
		memory.db.exec(TREE_WRITE_LOG_TABLE);
		memory.db
			.prepare(
				`INSERT INTO tree_write_log (at, bank, leaves, written, archived, adopted, removed_stale, gc)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				new Date().toISOString(),
				bank,
				result.leaves,
				result.written,
				result.archived,
				result.adopted,
				result.removedStale,
				result.gc,
			);
		memory.db
			.prepare(
				`DELETE FROM tree_write_log WHERE seq NOT IN (SELECT seq FROM tree_write_log ORDER BY seq DESC LIMIT ?)`,
			)
			.run(TREE_WRITE_LOG_KEEP);
	} catch (error) {
		logger.warn("Mnemopi: tree write-log append failed.", { error: String(error) });
	}
}

/** Read the most recent reconcile-pass records for status output. */
export function readTreeWriteLog(memory: Mnemopi, limit = 10): TreeWriteLogEntry[] {
	try {
		memory.db.exec(TREE_WRITE_LOG_TABLE);
		return memory.db
			.query(
				`SELECT at, bank, leaves, written, archived, adopted, removed_stale AS removedStale, gc
				 FROM tree_write_log ORDER BY seq DESC LIMIT ?`,
			)
			.all(Math.max(1, limit)) as TreeWriteLogEntry[];
	} catch {
		return [];
	}
}

/**
 * Normalised content match used by dedupe: whitespace-collapsed, case-folded.
 * The bank has no exact-match index on content, so the scan is bounded to the
 * most recent working-memory rows — enough to catch "same fact written twice".
 */
export function findMemoryIdByNormalizedContent(memory: Mnemopi, content: string, limit = 200): string | undefined {
	const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
	if (normalized === "") return undefined;
	const rows = memory.db
		.query(
			`SELECT id, content FROM working_memory
			 WHERE memory_type IS NULL OR memory_type != 'episode'
			 ORDER BY COALESCE(timestamp, '') DESC LIMIT ?`,
		)
		.all(limit) as { id: string; content: string }[];
	for (const row of rows) {
		if (row.content.replace(/\s+/g, " ").trim().toLowerCase() === normalized) return row.id;
	}
	return undefined;
}
