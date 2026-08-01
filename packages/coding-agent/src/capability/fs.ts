import * as fs from "node:fs";
import * as path from "node:path";
import { LRUCache } from "lru-cache/raw";

/**
 * Distinct files whose text (or negative "not a readable file" result) is
 * memoized. Discovery probes hundreds of candidate paths per pass — most
 * missing — so the entry count binds long before the byte ceiling does.
 */
export const CONTENT_CACHE_MAX_ENTRIES = 512;
/**
 * Ceiling on memoized file text, in UTF-16 code units. Worst case is 4 Mi
 * units, which JSC holds as at most 8 MB (two bytes per unit; ~4 MB for the
 * ASCII markdown and JSON discovery actually reads). Previously unbounded:
 * `readFile` retained the full text of every file any provider touched for
 * the life of the process, and `walkUp`/`findRepoRoot` walk to `/`, so every
 * ancestor of every cwd stayed resident forever.
 */
export const CONTENT_CACHE_MAX_CHARS = 4 * 1024 * 1024;
/**
 * Distinct directories whose `Dirent[]` listing is memoized. 256 covers the
 * ancestor chains of every cwd a session visits plus the foreign config trees
 * (`~/.claude`, `~/.cursor`, `.github`, plugin roots) discovery scans.
 */
export const DIR_CACHE_MAX_ENTRIES = 256;
/**
 * Ceiling on memoized directory entries. Worst case 32768 `Dirent`s, each
 * holding a name plus its parent path — on the order of 4-8 MB for deep
 * `node_modules`-sized listings, versus unbounded before.
 */
export const DIR_CACHE_MAX_DIRENTS = 32_768;

/**
 * Negative-result marker. `lru-cache` constrains values to non-nullish, and a
 * cached "this path is not a readable file" must stay distinguishable from
 * both a cache miss and a legitimately empty file.
 */
const UNREADABLE = Symbol("unreadable");

const contentCache = new LRUCache<string, string | typeof UNREADABLE>({
	max: CONTENT_CACHE_MAX_ENTRIES,
	maxSize: CONTENT_CACHE_MAX_CHARS,
	// Negative entries still occupy a slot; charge them 1 unit so `maxSize`
	// accounting stays positive and eviction can reclaim them.
	sizeCalculation: content => (typeof content === "string" ? content.length : 0) + 1,
});
const dirCache = new LRUCache<string, fs.Dirent[]>({
	max: DIR_CACHE_MAX_ENTRIES,
	maxSize: DIR_CACHE_MAX_DIRENTS,
	sizeCalculation: entries => entries.length + 1,
});

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

export async function readFile(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);
	// `UNREADABLE` is a cached negative result; only `undefined` is a miss.
	const cached = contentCache.get(abs);
	if (cached !== undefined) return cached === UNREADABLE ? null : cached;

	try {
		// Gate on the file type first: discovery scans foreign config dirs
		// (~/.claude, ~/.cursor, project trees), and reading a FIFO/socket/char
		// device with `.text()` blocks until EOF — i.e. forever — hanging
		// startup with zero output. `stat` follows symlinks, so symlinked
		// context files (CLAUDE.md -> AGENTS.md) still resolve.
		const stats = await fs.promises.stat(abs);
		if (!stats.isFile()) {
			contentCache.set(abs, UNREADABLE);
			return null;
		}
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		return content;
	} catch {
		contentCache.set(abs, UNREADABLE);
		return null;
	}
}

export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	const cached = dirCache.get(abs);
	if (cached !== undefined) return cached;

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		return entries;
	} catch {
		dirCache.set(abs, []);
		return [];
	}
}

export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
	return entries.map(entry => entry.name);
}

export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Results are based on the cached readDirEntries, so repeated calls are cheap.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
