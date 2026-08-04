/**
 * CLI handler for `loom scratch` — list and clean up per-run scratch dirs.
 *
 * Layout under `~/.loom/scratch/`:
 *
 *   - `t<digest>` — per-task scratch, created eagerly at subagent spawn.
 *   - `s<digest>` — per-interactive-session scratch, created at session start.
 *
 * Every dir carries an `owner.json` marker (`{pid, startedAt, repoRoot,
 * taskId, runId, worktree}`) written by `ensureScratchDir`. A dir is orphaned
 * when its owning process is gone and `SCRATCH_DEAD_OWNER_GRACE_MS` has
 * elapsed since the dir was last modified (the post-mortem forensics window);
 * marker-less legacy dirs get the same mtime-based grace. Live-owner dirs are
 * NEVER removed, not even by `clear --all`.
 *
 * Two rules keep that promise honest and keep this CLI in step with the
 * in-process sweep: entries are classified from `Dirent`/`lstat`, so a symlink
 * at the root is never followed, sized, or unlinked; and a root that is itself
 * a live run's dir is refused outright, because the liveness rule protects a
 * root's children rather than the root itself.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatBytes, isEnoent, logger } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	classifyTaskIsolation,
	isPidAlive,
	readTaskIsolationOwner,
	resolveScratchRootLogged,
	SCRATCH_DEAD_OWNER_GRACE_MS,
	type TaskIsolationOwner,
} from "../task/worktree-gc";

export interface ScratchEntry {
	/** Absolute path to the scratch dir under `~/.loom/scratch/`. */
	path: string;
	/** Directory name: `t<digest>` for tasks, `s<digest>` for sessions. */
	name: string;
	/** Total size in bytes (recursive walk, best-effort). */
	sizeBytes: number;
	/** Owner from the owner.json marker, when present and valid. */
	owner?: TaskIsolationOwner;
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
	/**
	 * Explicit confirmation for `--all` against the DEFAULT fleet root. `--all`
	 * waives the forensics grace, so on a root nobody chose it can wipe every
	 * crashed run's post-mortem in one keystroke — including after a rejected
	 * `OMP_SCRATCH_DIR` silently substituted that root.
	 */
	yes: boolean;
	json: boolean;
}

export async function listScratch(options: ListScratchOptions): Promise<void> {
	const root = resolveScratchRootLogged().path;
	if (await refusesLiveRunRoot(root, options.json)) return;
	const entries = await scanScratchDirs();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`No scratch dirs found under ${root}.`));
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
	const resolution = resolveScratchRootLogged();
	if (await refusesLiveRunRoot(resolution.path, options.json)) return;
	const entries = await scanScratchDirs();
	if (resolution.rejected !== undefined) {
		const substitution = `Substituted scratch root: OMP_SCRATCH_DIR=${resolution.rejected} names a run's own dir, using ${resolution.path} (${resolution.source}) with ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`;
		if (!options.json) console.log(chalk.yellow(substitution));
		logger.warn("scratch clear resolved a substituted root", {
			rejected: resolution.rejected,
			resolved: resolution.path,
			source: resolution.source,
			entries: entries.length,
		});
	}
	// Liveness rule: a dir whose owner pid is alive is never deleted, not even
	// by --all. `--all` widens the target set from orphaned-only to everything
	// without a live owner (i.e. it bypasses the dead/legacy grace windows).
	const targets = options.all
		? entries.filter(entry => !entry.live)
		: entries.filter(entry => entry.orphanReason !== undefined);

	if (targets.length === 0) {
		if (options.json) {
			console.log(
				JSON.stringify({ root: resolution.path, rootSource: resolution.source, removed: 0, kept: entries.length }),
			);
		} else {
			console.log(chalk.dim(options.all ? "No scratch dirs to remove." : "No orphaned scratch dirs to remove."));
		}
		return;
	}

	// Enumerate BEFORE unlinking, always. A summary printed afterwards loses
	// the names of everything it just destroyed — which is exactly how a
	// mistaken `--all` becomes unauditable. `--dry-run` is this block and
	// nothing else.
	if (options.json) {
		console.log(
			JSON.stringify(
				{
					root: resolution.path,
					rootSource: resolution.source,
					all: options.all,
					wouldRemove: targets.map(t => t.path),
				},
				null,
				2,
			),
		);
	} else {
		for (const target of targets) {
			console.log(`${chalk.yellow("would remove")}  ${target.path}`);
		}
		console.log(
			chalk.dim(
				`\n${targets.length} dir${targets.length === 1 ? "" : "s"} would be removed from ${resolution.path} (${resolution.source} root).`,
			),
		);
	}
	if (options.dryRun) return;

	// `--all` on a root nobody selected is the fleet's whole forensics window.
	// An explicitly configured root (env var or `scratch.base`) is a deliberate
	// target and needs no ceremony.
	if (options.all && resolution.source === "default" && !options.yes) {
		const reason = `Refusing --all against the default scratch root ${resolution.path}: it holds every run's post-mortem scratch and --all waives the ${SCRATCH_DEAD_OWNER_GRACE_MS / 3_600_000}h grace. The ${targets.length} dir${targets.length === 1 ? " listed above was" : "s listed above were"} NOT removed. Re-run with --yes to confirm, or --dry-run to inspect.`;
		if (options.json) console.log(JSON.stringify({ refused: true, needsConfirmation: true, reason }, null, 2));
		else console.log(chalk.yellow(reason));
		process.exitCode = 1;
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

/**
 * Refuse to treat a live run's OWN scratch dir as the scratch root. Reached
 * when something points the root at a run dir (a stale `scratch.base`, a
 * hand-set variable): every "entry" under it would then be that run's live
 * work product, and `clear --all` bypasses every grace window because the
 * marker protecting that run sits one level up. Prints why and returns true
 * when the command must stop.
 */
async function refusesLiveRunRoot(root: string, json: boolean): Promise<boolean> {
	const owner = await readTaskIsolationOwner(root);
	if (owner === null || !isPidAlive(owner.pid)) return false;
	const reason = `${root} is a live run's own scratch dir (owner pid ${owner.pid}, task ${owner.taskId}), not a scratch root — refusing. Its subdirectories are that run's work product. Point the root at the scratch root (unset OMP_SCRATCH_DIR or fix scratch.base); a run's own dir is exported as OMP_RUN_SCRATCH.`;
	if (json) console.log(JSON.stringify({ refused: true, root, reason }, null, 2));
	else console.log(chalk.yellow(reason));
	return true;
}

async function scanScratchDirs(): Promise<ScannedScratchEntry[]> {
	const root = resolveScratchRootLogged().path;
	let topLevel: Dirent[];
	try {
		topLevel = await fs.readdir(root, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: ScannedScratchEntry[] = [];
	for (const entry of topLevel) {
		// lstat semantics, matching the sweep's `Dirent.isDirectory()`: a
		// symlink at the root is not a scratch dir. Following it reported the
		// TARGET's size, classified the link as an orphaned legacy leftover,
		// and unlinked it — while the in-process sweep ignored it entirely.
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		const dir = path.join(root, name);
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
			const stat = await fs.lstat(childPath).catch(() => null);
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
