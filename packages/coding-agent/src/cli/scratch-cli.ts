/**
 * CLI handler for `loom scratch` — list and clean up per-run scratch dirs.
 *
 * Layout under `~/.loom/scratch/`:
 *
 *   - `t<digest>` — per-task scratch, created eagerly at subagent spawn.
 *   - `s<digest>` — per-interactive-session scratch, created at session start.
 *
 * Every dir carries an `owner.json` marker (`{pid, startedAt, repoRoot,
 * taskId}`) written by `ensureScratchDir`. A dir is orphaned when its owning
 * process is gone and `SCRATCH_DEAD_OWNER_GRACE_MS` has elapsed since the dir
 * was last modified (the post-mortem forensics window); marker-less legacy
 * dirs get the same mtime-based grace. Live-owner dirs are NEVER removed,
 * not even by `clear --all`.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatBytes, getScratchDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { classifyTaskIsolation, isPidAlive, SCRATCH_DEAD_OWNER_GRACE_MS } from "../task/worktree-gc";

export interface ScratchEntry {
	/** Absolute path to the scratch dir under `~/.loom/scratch/`. */
	path: string;
	/** Directory name: `t<digest>` for tasks, `s<digest>` for sessions. */
	name: string;
	/** Total size in bytes (recursive walk, best-effort). */
	sizeBytes: number;
	/** Owner from the owner.json marker, when present and valid. */
	owner?: { pid: number; startedAt: string; repoRoot: string; taskId: string };
	/** When set, the entry is orphaned and `loom scratch clear` will remove it. */
	orphanReason?: string;
}

export interface ListScratchOptions {
	json: boolean;
}

export interface ClearScratchOptions {
	/** Remove every entry that has no live owner, including ones still inside the grace window. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	json: boolean;
}

export async function listScratch(options: ListScratchOptions): Promise<void> {
	const entries = await scanScratchDirs();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`No scratch dirs found under ${getScratchDir()}.`));
		return;
	}
	let live = 0;
	let orphaned = 0;
	let grace = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason
			? chalk.yellow("orphaned")
			: entry.live
				? chalk.green("live    ")
				: chalk.cyan("grace   ");
		console.log(`${tag}  ${formatBytes(entry.sizeBytes).padStart(9)}  ${entry.path}`);
		const detail = formatEntryDetail(entry);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else if (entry.live) live += 1;
		else grace += 1;
	}
	console.log(chalk.dim(`\n${live} live · ${orphaned} orphaned · ${grace} in grace · ${entries.length} total`));
}

export async function clearScratch(options: ClearScratchOptions): Promise<void> {
	const entries = await scanScratchDirs();
	// Liveness rule: a dir whose owner pid is alive is never deleted, not even
	// by --all. `--all` widens the target set from orphaned-only to everything
	// without a live owner (i.e. it bypasses the dead/legacy grace windows).
	const targets = options.all
		? entries.filter(entry => !entry.live)
		: entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "No scratch dirs to remove." : "No orphaned scratch dirs to remove."));
		}
		return;
	}

	if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow("would remove")}  ${target.path}`);
			}
			console.log(chalk.dim(`\n${targets.length} dir${targets.length === 1 ? "" : "s"} would be removed.`));
		}
		return;
	}

	const results: { path: string; ok: boolean; error?: string }[] = [];
	for (const target of targets) {
		try {
			await fs.rm(target.path, { recursive: true, force: true });
			results.push({ path: target.path, ok: true });
		} catch (err) {
			results.push({ path: target.path, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
	const succeeded = results.filter(r => r.ok).length;
	const failed = results.length - succeeded;

	if (options.json) {
		console.log(JSON.stringify({ removed: succeeded, failed, results }, null, 2));
	} else {
		for (const result of results) {
			if (result.ok) {
				console.log(`${chalk.green("removed")}  ${result.path}`);
			} else {
				console.log(`${chalk.red("failed ")}  ${result.path}`);
				if (result.error) console.log(`          ${chalk.dim(result.error)}`);
			}
		}
		console.log(chalk.dim(`\n${succeeded} removed${failed > 0 ? ` · ${chalk.red(`${failed} failed`)}` : ""}`));
	}
	if (failed > 0) process.exitCode = 1;
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

interface ScannedScratchEntry extends ScratchEntry {
	/** True when the owner marker names a live process. */
	live: boolean;
}

async function scanScratchDirs(): Promise<ScannedScratchEntry[]> {
	const root = getScratchDir();
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: ScannedScratchEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root, name);
		const stat = await fs.stat(dir).catch(() => null);
		if (!stat?.isDirectory()) continue;
		const classified = await classifyTaskIsolation(dir, SCRATCH_DEAD_OWNER_GRACE_MS);
		const sizeBytes = await dirSizeBytes(dir);
		const owner = classified.owner ?? undefined;
		entries.push({
			path: dir,
			name,
			sizeBytes,
			owner,
			live: owner !== undefined && isPidAlive(owner.pid),
			orphanReason: classified.orphaned ? (classified.orphanReason ?? "scratch leftover") : undefined,
		});
	}
	// Largest first so runaway dirs are visible without scrolling.
	entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
	return entries;
}

async function dirSizeBytes(dir: string): Promise<number> {
	let total = 0;
	let children: Dirent[];
	try {
		children = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const child of children) {
		const childPath = path.join(dir, child.name);
		if (child.isDirectory()) {
			total += await dirSizeBytes(childPath);
		} else {
			const stat = await fs.stat(childPath).catch(() => null);
			if (stat) total += stat.size;
		}
	}
	return total;
}

function formatEntryDetail(entry: ScratchEntry): string {
	const parts: string[] = [];
	if (entry.owner) {
		parts.push(`owner pid ${entry.owner.pid} since ${entry.owner.startedAt}`);
		parts.push(entry.owner.taskId);
	} else {
		parts.push("no owner marker");
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	return parts.join(" · ");
}
