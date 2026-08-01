/**
 * Liveness-aware garbage collection for task-isolation workspaces under
 * `getWorktreesDir()` (`~/.loom/wt/`).
 *
 * Each task-isolation base dir is a wrapper containing an `m` (legacy:
 * `merged`) mount subdir plus an `owner.json` marker written by
 * `ensureIsolation` recording the owning loom process. A dir is orphaned when
 * its owning process is gone; legacy dirs without a marker get a grace window
 * based on directory mtime so in-flight creations are never swept.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getScratchDir, getWorktreesDir, logger } from "@oh-my-pi/pi-utils";

/** Marker file recording which loom process owns a task-isolation workspace. */
export const TASK_ISOLATION_OWNER_FILE = "owner.json";

/** Grace window for legacy task-isolation dirs that carry no owner marker. */
export const TASK_ISOLATION_STALE_GRACE_MS = 86_400_000; // 24h

/**
 * Grace window before a scratch dir whose owner process is gone is swept.
 * Unlike worktrees (merged/captured at task end, so dead-owner ⇒ immediate
 * removal), scratch content exists nowhere else — the grace is the post-mortem
 * forensics window after a hard kill. Nothing writes to the dir once the owner
 * dies, so mtime ≈ death time.
 */
export const SCRATCH_DEAD_OWNER_GRACE_MS = 86_400_000; // 24h

/** Mount subdirs that mark a top-level dir as a task-isolation workspace. */
const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

export interface TaskIsolationOwner {
	pid: number;
	startedAt: string;
	repoRoot: string;
	taskId: string;
}

export interface TaskIsolationClass {
	orphaned: boolean;
	orphanReason?: string;
	owner: TaskIsolationOwner | null;
}

export interface TaskIsolationSweepResult {
	removed: string[];
	failed: { path: string; error: string }[];
}

/**
 * Read and validate the owner marker of a task-isolation base dir. Returns
 * null when the marker is missing, unreadable, corrupt, or malformed.
 */
export async function readTaskIsolationOwner(baseDir: string): Promise<TaskIsolationOwner | null> {
	let raw: string;
	try {
		raw = await fs.readFile(path.join(baseDir, TASK_ISOLATION_OWNER_FILE), "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const candidate = parsed as Record<string, unknown>;
	if (
		typeof candidate.pid !== "number" ||
		typeof candidate.startedAt !== "string" ||
		typeof candidate.repoRoot !== "string" ||
		typeof candidate.taskId !== "string"
	) {
		return null;
	}
	return {
		pid: candidate.pid,
		startedAt: candidate.startedAt,
		repoRoot: candidate.repoRoot,
		taskId: candidate.taskId,
	};
}

/**
 * Probe whether a process exists. ESRCH means gone; EPERM means it exists but
 * belongs to another user, which still counts as alive.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return false;
	}
}

/**
 * Classify one managed workspace dir. Dirs with a live owner are never
 * orphaned; dirs with a dead owner are, once `deadGraceMs` has elapsed since
 * the dir was last modified (0 = immediately, the worktree policy). Dirs
 * without a marker fall back to a mtime-based grace window covering legacy
 * layouts and in-flight creation.
 */
export async function classifyTaskIsolation(baseDir: string, deadGraceMs = 0): Promise<TaskIsolationClass> {
	const owner = await readTaskIsolationOwner(baseDir);
	if (owner !== null) {
		if (isPidAlive(owner.pid)) {
			return { orphaned: false, owner };
		}
		if (deadGraceMs > 0) {
			try {
				const stat = await fs.stat(baseDir);
				if (Date.now() - stat.mtimeMs <= deadGraceMs) {
					return { orphaned: false, owner };
				}
			} catch {
				// Unstattable dirs are not swept.
				return { orphaned: false, owner };
			}
		}
		return { orphaned: true, orphanReason: `owner process ${owner.pid} is gone`, owner };
	}
	try {
		const stat = await fs.stat(baseDir);
		if (Date.now() - stat.mtimeMs > TASK_ISOLATION_STALE_GRACE_MS) {
			return {
				orphaned: true,
				orphanReason: "legacy task-isolation leftover (no owner marker)",
				owner: null,
			};
		}
	} catch {
		// Unstattable dirs are not swept.
	}
	return { orphaned: false, owner: null };
}

async function hasMountSubdir(dir: string): Promise<boolean> {
	for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
		try {
			if ((await fs.stat(path.join(dir, mountDir))).isDirectory()) return true;
		} catch {
			// Missing subdir; try the next candidate.
		}
	}
	return false;
}

interface SweepRootOptions {
	/** Only consider dirs carrying an `m`/`merged` mount subdir (worktree root). */
	requireMountSubdir: boolean;
	/** Grace before a dead owner's dir is removed; 0 removes on sight. */
	deadGraceMs: number;
}

/**
 * Best-effort sweep of orphaned workspaces under `root`. Never throws: a
 * missing root yields empty results and per-dir failures are collected into
 * `failed`.
 */
async function sweepRoot(root: string, options: SweepRootOptions): Promise<TaskIsolationSweepResult> {
	const result: TaskIsolationSweepResult = { removed: [], failed: [] };
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const baseDir = path.join(root, entry.name);
		try {
			if (options.requireMountSubdir && !(await hasMountSubdir(baseDir))) continue;
			const classification = await classifyTaskIsolation(baseDir, options.deadGraceMs);
			if (!classification.orphaned) continue;
			await fs.rm(baseDir, { recursive: true, force: true });
			result.removed.push(baseDir);
			logger.debug("swept orphaned workspace", {
				baseDir,
				reason: classification.orphanReason,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.failed.push({ path: baseDir, error: message });
			logger.warn("failed to sweep orphaned workspace", { baseDir, error: message });
		}
	}
	return result;
}

/**
 * Best-effort sweep of orphaned task-isolation workspaces under
 * `getWorktreesDir()`. Never throws: a missing root yields empty results and
 * per-dir failures are collected into `failed`.
 */
export async function sweepOrphanedTaskIsolations(): Promise<TaskIsolationSweepResult> {
	return sweepRoot(getWorktreesDir(), { requireMountSubdir: true, deadGraceMs: 0 });
}

/**
 * Best-effort sweep of orphaned scratch dirs under `getScratchDir()`. A dir
 * whose owner process is gone is kept for {@link SCRATCH_DEAD_OWNER_GRACE_MS}
 * (forensics window) before removal; live-owner dirs are never removed.
 */
export async function sweepOrphanedScratchDirs(): Promise<TaskIsolationSweepResult> {
	return sweepRoot(getScratchDir(), { requireMountSubdir: false, deadGraceMs: SCRATCH_DEAD_OWNER_GRACE_MS });
}

let workspaceSweepDone = false;

/**
 * Fire both workspace sweeps (worktree root + scratch root) once per process,
 * fire-and-forget. Called from workspace creation sites so every loom process
 * that spawns work also reaps what crashed processes left behind.
 */
export function sweepOrphanedWorkspacesOnce(): void {
	if (workspaceSweepDone) return;
	workspaceSweepDone = true;
	void sweepOrphanedTaskIsolations().catch(() => {});
	void sweepOrphanedScratchDirs().catch(() => {});
}
