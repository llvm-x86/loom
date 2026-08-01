/**
 * Per-session snapshot store used by {@link Recovery} and {@link Patcher} to
 * bind hashline section tags to the exact file content that minted them.
 *
 * A section tag is a content-derived hash of the *whole file* (see
 * {@link computeFileHash}). Any read of byte-identical content mints the same
 * tag, so reads of one file state fuse onto one anchor and a follow-up edit
 * anchored at any line validates whenever the live file still hashes to it.
 *
 * Producers (typically `read` / `search` / `write` tools) call
 * {@link SnapshotStore.record} with the full normalized text they observed.
 * The store hashes it, dedups against the per-path history, and returns the
 * tag. Consumers (recovery, the patcher) resolve a stale tag back to the
 * recorded full text and map its unchanged edit anchors onto live content.
 *
 * The abstract base class lets callers plug in whatever storage they like
 * (LRU, persistent SQLite, etc.). {@link InMemorySnapshotStore} ships as a
 * sensible default backed by `lru-cache`: a bounded set of paths, each with a
 * short history of full-file versions so in-session edit chains can still
 * recover against the version a stale tag names.
 */
import { LRUCache } from "lru-cache/raw";
import { computeFileHash } from "./format";

/**
 * The 1-indexed file lines a producer displayed, stored as sorted, disjoint,
 * inclusive ranges instead of one entry per line.
 *
 * Reads are overwhelmingly contiguous — a whole-file read is a single range,
 * a `:50-200` selector is a single range, a structural summary is a handful —
 * so the flat `[start0, end0, start1, end1, …]` number array holds 16 bytes
 * per *run* where the previous `Set<number>` held one hash-table slot per
 * *line*. Reading a 50k-line file used to materialise a 50k-element Set
 * (~2 MB in JSC); it is now two array slots.
 *
 * Worst case is a maximally sparse read (only odd-numbered lines displayed),
 * which degenerates to one range per line: 2 packed doubles = 16 bytes per
 * seen line, still below the ~32-40 bytes/entry a `Set<number>` costs. The
 * representation is therefore never worse than the Set it replaces.
 *
 * Exposes exactly the surface the patcher's seen-line guard consumes
 * ({@link size}, {@link has}) plus ascending iteration.
 */
export class SeenLines {
	/** Flat `[start0, end0, start1, end1, …]`, ascending and non-adjacent. */
	readonly #ranges: number[] = [];
	#size = 0;

	/** Number of distinct lines recorded (not the number of ranges). */
	get size(): number {
		return this.#size;
	}

	/** Whether `line` (1-indexed) was displayed. */
	has(line: number): boolean {
		const ranges = this.#ranges;
		let lo = 0;
		let hi = (ranges.length >> 1) - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const i = mid << 1;
			if (line < ranges[i]) hi = mid - 1;
			else if (line > ranges[i + 1]) lo = mid + 1;
			else return true;
		}
		return false;
	}

	/**
	 * Record `line` as displayed. Idempotent. Ascending insertion (the shape
	 * every producer emits) extends the tail range in O(log n) with no splice.
	 */
	add(line: number): void {
		const ranges = this.#ranges;
		const count = ranges.length >> 1;
		// First range whose end is >= line - 1: the only candidate that can
		// contain `line`, abut it on the left, or need `line` spliced before it.
		let lo = 0;
		let hi = count;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ranges[(mid << 1) + 1] < line - 1) lo = mid + 1;
			else hi = mid;
		}
		const i = lo << 1;
		if (lo < count && ranges[i] <= line && line <= ranges[i + 1]) return;
		this.#size++;
		if (lo < count && ranges[i + 1] === line - 1) {
			ranges[i + 1] = line;
			// The gap to the next range may have just closed; fuse them.
			if (lo + 1 < count && ranges[i + 2] === line + 1) {
				ranges[i + 1] = ranges[i + 3];
				ranges.splice(i + 2, 2);
			}
			return;
		}
		if (lo < count && ranges[i] === line + 1) {
			ranges[i] = line;
			return;
		}
		ranges.splice(i, 0, line, line);
	}

	/** Every recorded line, ascending. */
	*[Symbol.iterator](): IterableIterator<number> {
		const ranges = this.#ranges;
		for (let i = 0; i < ranges.length; i += 2) {
			for (let line = ranges[i]; line <= ranges[i + 1]; line++) yield line;
		}
	}
}

/**
 * One full-file version observed at a point in time. The tag the model sees is
 * {@link Snapshot.hash}; recovery replays edits against {@link Snapshot.text}.
 */
export interface Snapshot {
	/** Canonical path this version belongs to. */
	readonly path: string;
	/** Full normalized (LF, no BOM) file text as observed. */
	readonly text: string;
	/** Content-derived tag for {@link Snapshot.text} (see {@link computeFileHash}). */
	readonly hash: string;
	/** Timestamp (ms since epoch) the version was recorded. */
	recordedAt: number;
	/**
	 * 1-indexed file lines a producer (read/search) actually *displayed* under
	 * this tag. A partial read (range, or a structural summary that collapsed
	 * bodies) leaves this sparse; a whole-file read fills every line. Multiple
	 * reads of the same content union into one set. `undefined` means "no
	 * provenance recorded" — the patcher then skips the seen-line check and
	 * applies as before. Mutated in place as more of the same content is read.
	 */
	seenLines?: SeenLines;
}

/**
 * Storage seam for full-file version snapshots. The patcher calls {@link head}
 * for the latest version of a path and {@link byHash} when it needs the
 * historical version a section's stale tag names.
 */
export abstract class SnapshotStore {
	/** Most-recently recorded version for `path`, or `null` if none. */
	abstract head(path: string): Snapshot | null;

	/**
	 * Recorded version for `path` whose tag equals `hash`, or `null`. When two
	 * distinct texts collide on the 16-bit tag, returns the most-recently
	 * recorded one.
	 */
	abstract byHash(path: string, hash: string): Snapshot | null;

	/**
	 * Recorded version for `path` whose {@link Snapshot.text} equals `fullText`,
	 * or `null`. The patcher uses it on the no-drift path to attach seen-line
	 * provenance to the exact text the model read.
	 */
	abstract byContent(path: string, fullText: string): Snapshot | null;

	/**
	 * Every retained version whose tag equals `hash`, across all tracked
	 * paths. The patcher uses this to recover the intended file when a section
	 * names a path that does not exist on disk but carries a tag the store
	 * minted — the model mistyped the path of a file it read this session.
	 *
	 * The base returns no matches (recovery disabled); stores that can
	 * enumerate their contents override it to enable tag-based path recovery.
	 */
	findByHash(_hash: string): Snapshot[] {
		return [];
	}

	/**
	 * Record the full normalized text of `path` and return its content tag.
	 * `seenLines` (optional) are the 1-indexed lines the producer displayed;
	 * they merge into {@link Snapshot.seenLines} across reads of identical text.
	 */
	abstract record(path: string, fullText: string, seenLines?: Iterable<number>): string;

	/**
	 * Merge `lines` into the {@link Snapshot.seenLines} of the version whose tag
	 * equals `hash`. No-op when no such version is retained (the content aged
	 * out or was overwritten). Lets producers attach displayed lines after the
	 * tag was already minted (the body is formatted after the hash is computed).
	 */
	abstract recordSeenLines(path: string, hash: string, lines: Iterable<number>): void;

	/** Drop the version history for a single path. */
	abstract invalidate(path: string): void;

	/**
	 * Move retained version history (and read provenance) from `from` to `to`.
	 * No-op when `from` has no history. Used by file moves so tags minted from
	 * reads of the source path stay valid at the destination.
	 */
	abstract relocate(from: string, to: string): void;

	/** Drop every version history. */
	abstract clear(): void;
}

/**
 * Distinct paths whose version history is tracked at once. Cold paths are
 * LRU-evicted. Worst case is bounded by {@link DEFAULT_MAX_TOTAL_BYTES}, not
 * by this: 30 paths only reach the byte ceiling when each averages ~273 KiB.
 */
export const DEFAULT_MAX_PATHS = 30;
/**
 * Full-file versions retained per path, newest first.
 *
 * 2 = the live content plus the one state it was edited from. That is the
 * depth the patcher's stale-tag recovery actually replays: a section tagged
 * with the pre-edit content resolves against version 1 and its anchors are
 * remapped onto the live text. A tag naming an *older* state than that misses,
 * the patcher rejects the section with the usual stale-tag error, and the
 * model re-reads — the same recovery path a cold cache already takes.
 *
 * Worst case: {@link DEFAULT_MAX_PATHS} x 2 versions, still clamped by
 * {@link DEFAULT_MAX_TOTAL_BYTES}.
 */
export const DEFAULT_MAX_VERSIONS_PER_PATH = 2;
/**
 * Global ceiling on retained snapshot text across all paths, measured in
 * UTF-16 code units. Least-recently-used path histories are evicted to stay
 * under it.
 *
 * Worst case: 8 Mi code units of retained text, which JSC holds as at most
 * 16 MB (two bytes per unit for non-Latin-1 sources; ~8 MB for ASCII code).
 * The previous 64 MiB ceiling permitted 128 MB of resident file text — larger
 * than a whole fresh session's RSS — and was never reached before the process
 * paid for it. 8 MiB still holds the two largest files a session realistically
 * edits at once (the per-file admission cap is 4 MiB) or dozens of ordinary
 * source files.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** Union `lines` into `snapshot.seenLines`, lazily creating the range set. */
function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	snapshot.seenLines ??= new SeenLines();
	for (const line of lines) snapshot.seenLines.add(line);
}

export interface InMemorySnapshotStoreOptions {
	/** Maximum number of distinct paths tracked at once. LRU eviction. Defaults to {@link DEFAULT_MAX_PATHS}. */
	maxPaths?: number;
	/** Maximum full-file versions retained per path; oldest dropped first. Defaults to {@link DEFAULT_MAX_VERSIONS_PER_PATH}. */
	maxVersionsPerPath?: number;
	/**
	 * Global ceiling on retained snapshot text summed across every path's
	 * version history, measured in UTF-16 code units. Least-recently-used path
	 * histories are evicted to stay under it. Defaults to
	 * {@link DEFAULT_MAX_TOTAL_BYTES}.
	 */
	maxTotalBytes?: number;
}

/**
 * In-memory {@link SnapshotStore} backed by `lru-cache`. Per-path history is a
 * short ring of full-file versions (oldest dropped first); per-session path
 * tracking is LRU-bounded so cold paths age out automatically.
 *
 * Recording byte-identical content again refreshes recency and reuses the
 * existing tag (read fusion); recording new content unshifts a fresh version
 * onto the front of the path history. Two distinct texts that collide on the
 * short 4-hex tag are retained as separate versions so callers can still tell
 * them apart via {@link Snapshot.text} — the tag is only a fast index, never
 * the identity.
 */
export class InMemorySnapshotStore extends SnapshotStore {
	readonly #versions: LRUCache<string, Snapshot[]>;
	readonly #maxVersionsPerPath: number;

	constructor(options: InMemorySnapshotStoreOptions = {}) {
		super();
		this.#versions = new LRUCache<string, Snapshot[]>({
			max: options.maxPaths ?? DEFAULT_MAX_PATHS,
			maxSize: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
			sizeCalculation: history => {
				let total = 1;
				for (const version of history) total += version.text.length;
				return total;
			},
		});
		this.#maxVersionsPerPath = options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
	}

	head(path: string): Snapshot | null {
		return this.#versions.get(path)?.[0] ?? null;
	}

	byHash(path: string, hash: string): Snapshot | null {
		const history = this.#versions.get(path);
		return history?.find(version => version.hash === hash) ?? null;
	}

	byContent(path: string, fullText: string): Snapshot | null {
		const history = this.#versions.get(path);
		return history?.find(version => version.text === fullText) ?? null;
	}

	findByHash(hash: string): Snapshot[] {
		const matches: Snapshot[] = [];
		for (const history of this.#versions.values()) {
			for (const version of history) {
				if (version.hash === hash) matches.push(version);
			}
		}
		return matches;
	}

	record(path: string, fullText: string, seenLines?: Iterable<number>): string {
		const hash = computeFileHash(fullText);
		// `get` refreshes LRU recency for `path`.
		const history = this.#versions.get(path) ?? [];
		// Dedup requires full-text equality, not just tag equality: two distinct
		// texts that happen to share the 4-hex tag are DIFFERENT snapshots — fusing
		// them under one entry would corrupt seenLines (attaching lines from
		// text B onto the stored text A) and let the patcher misresolve which
		// snapshot the section tag names during recovery or seen-line validation.
		// See issue #4075.
		const existing = history.find(version => version.hash === hash && version.text === fullText);
		if (existing) {
			// Same content state observed again: refresh recency and promote to
			// head (it is the current file content), then reuse the tag. Union any
			// newly-displayed lines so re-reading more of the file widens coverage.
			existing.recordedAt = Date.now();
			mergeSeenLines(existing, seenLines);
			if (history[0] !== existing) {
				this.#versions.set(path, [existing, ...history.filter(version => version !== existing)]);
			}
			return hash;
		}

		const snapshot: Snapshot = { path, text: fullText, hash, recordedAt: Date.now() };
		mergeSeenLines(snapshot, seenLines);
		this.#versions.set(path, [snapshot, ...history].slice(0, this.#maxVersionsPerPath));
		return hash;
	}

	recordSeenLines(path: string, hash: string, lines: Iterable<number>): void {
		const version = this.#versions.get(path)?.find(snapshot => snapshot.hash === hash);
		if (version) mergeSeenLines(version, lines);
	}

	invalidate(path: string): void {
		this.#versions.delete(path);
	}

	relocate(from: string, to: string): void {
		const sourceHistory = this.#versions.get(from);
		if (sourceHistory === undefined || sourceHistory.length === 0) return;
		const relocated = sourceHistory.map(version => ({ ...version, path: to }));
		const destHistory = this.#versions.get(to);
		if (destHistory === undefined) {
			this.#versions.set(to, relocated);
		} else {
			const seen = new Set<string>();
			const merged: Snapshot[] = [];
			for (const version of [...relocated, ...destHistory]) {
				if (seen.has(version.hash)) continue;
				seen.add(version.hash);
				merged.push(version);
			}
			this.#versions.set(to, merged.slice(0, this.#maxVersionsPerPath));
		}
		this.#versions.delete(from);
	}

	clear(): void {
		this.#versions.clear();
	}
}
