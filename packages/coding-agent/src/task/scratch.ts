/**
 * Per-run scratch directories under `getScratchDir()` (`~/.loom/scratch/`).
 *
 * Every task subagent and every interactive session gets an owned, eagerly
 * created scratch dir for disposable files (repro scripts, fixtures, temp
 * JSON, downloaded archives). Naming reuses {@link getTaskIsolationSegment}:
 * tasks get `t<digest>` (identical to their worktree dir name, so forensics
 * correlation is free) and interactive sessions get `s<digest>` from the same
 * digest over `(repoRoot, sessionId)`.
 *
 * Ownership uses the byte-identical owner.json schema as task-isolation
 * worktrees (`{pid, startedAt, repoRoot, taskId}`; `taskId` is the session id
 * for `s` dirs), so `readTaskIsolationOwner`/`isPidAlive` and the liveness
 * sweep apply unchanged. Scratch has no merge path, so the sweep keeps
 * dead-owner dirs for `SCRATCH_DEAD_OWNER_GRACE_MS` before removal — that
 * window is the post-mortem forensics budget after a hard kill.
 *
 * All creation is best-effort and never breaks spawn: failures are logged and
 * reported as `undefined`, and callers degrade to "no scratch dir".
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getScratchDir, logger } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { sweepOrphanedWorkspacesOnce, TASK_ISOLATION_OWNER_FILE } from "./worktree-gc";
import { getTaskIsolationSegment } from "./worktree";

/** Which run a scratch dir belongs to; selects the dir-name prefix. */
export type ScratchKind = "task" | "session";

const SCRATCH_DIR_PREFIX: Record<ScratchKind, string> = { task: "t", session: "s" };

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Re-assert that a previously created scratch dir (and its `tmp` subdir)
 * exists. Used by the subagent revive path: a swept or externally removed dir
 * must not break the revived session — the prompt names it, so it must be
 * there. Best-effort; never throws.
 */
export async function assertScratchDir(baseDir: string): Promise<void> {
	try {
		await fs.mkdir(path.join(baseDir, "tmp"), { recursive: true });
	} catch (err) {
		logger.warn("scratch dir re-assert failed", { baseDir, error: errorMessage(err) });
	}
}

/**
 * Create (or re-assert) the scratch dir for one run and write its owner
 * marker. Returns the absolute dir path, or `undefined` when creation failed
 * (best-effort — a failed scratch dir must never break a spawn).
 */
export async function ensureScratchDir(cwd: string, id: string, kind: ScratchKind): Promise<string | undefined> {
	try {
		// The worktree digest keys on the git repo root; scratch keys on the
		// same value so the names correlate. Outside a checkout the resolved
		// cwd stands in — scratch exists for non-repo runs too.
		const repoRoot = (await git.repo.root(cwd)) ?? path.resolve(cwd);
		const baseDir = path.join(getScratchDir(), getTaskIsolationSegment(repoRoot, id, SCRATCH_DIR_PREFIX[kind]));
		await fs.mkdir(path.join(baseDir, "tmp"), { recursive: true });
		// Mark ownership so the GC can distinguish a live run's scratch from a
		// crashed process's leftover. Byte-identical schema to the worktree
		// owner marker; a failed write must never break spawn.
		try {
			await fs.writeFile(
				path.join(baseDir, TASK_ISOLATION_OWNER_FILE),
				JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), repoRoot, taskId: id }),
			);
		} catch (err) {
			logger.warn("scratch owner marker write failed", { baseDir, error: errorMessage(err) });
		}
		sweepOrphanedWorkspacesOnce();
		return baseDir;
	} catch (err) {
		logger.warn("scratch dir creation failed", { cwd, id, kind, error: errorMessage(err) });
		return undefined;
	}
}

/**
 * Tool-env entries routing a run's disposable writes into its scratch dir.
 * `OMP_SCRATCH_DIR` names the dir for scripts; `TMPDIR` (when the
 * `scratch.tmpdirRedirect` kill switch is on) routes `mktemp`, `tempfile`,
 * and library temp defaults into owned, GC'd space with zero model
 * cooperation. Returns `undefined` when the run has no scratch dir.
 */
export function buildScratchToolEnv(
	scratchDir: string | undefined,
	tmpdirRedirect: boolean,
): Record<string, string> | undefined {
	if (!scratchDir) return undefined;
	if (!tmpdirRedirect) return { OMP_SCRATCH_DIR: scratchDir };
	return { OMP_SCRATCH_DIR: scratchDir, TMPDIR: path.join(scratchDir, "tmp") };
}
