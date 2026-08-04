/**
 * Per-run scratch directories under `getScratchDir()` (`~/.loom/scratch/`).
 *
 * Every task subagent and every interactive session gets an owned, eagerly
 * created scratch dir for disposable files (repro scripts, fixtures, temp
 * JSON, downloaded archives). The dir name is a digest over
 * `(repoRoot, taskId, runId)`: tasks get `t<digest>` and interactive sessions
 * get `s<digest>`.
 *
 * `runId` is what makes a dir belong to exactly one run. A subagent's taskId is
 * its agent NAME, so `(repoRoot, taskId)` alone collides whenever two runs
 * share a name in one repo — observed live, with two agents writing into one
 * dir and `owner.json` recording only the last writer. Tasks therefore mint a
 * fresh `runId` per spawn; sessions use their session id, which is stable
 * across resumes so a resumed session finds its own files again.
 *
 * The cost of that fix is that a task's scratch dir name no longer equals its
 * task-isolation worktree dir name. That trade is correct: the worktree name
 * was only ever a forensics convenience, while the collision it caused was
 * silent data loss between live agents. The correlation is kept as the
 * `worktree` field inside `owner.json`, where it is exact rather than implied.
 *
 * Ownership reuses the task-isolation owner marker (`{pid, startedAt,
 * repoRoot, taskId}` plus scratch's `runId`/`worktree`), so
 * `readTaskIsolationOwner`/`isPidAlive` and the liveness sweep apply
 * unchanged. Scratch has no merge path, so the sweep keeps dead-owner dirs for
 * `SCRATCH_DEAD_OWNER_GRACE_MS` before removal — that window is the
 * post-mortem forensics budget after a hard kill.
 *
 * A claim never steals a marker whose pid is alive: a resume, a re-assert, or
 * a same-session helper process (`sync-context --resume`) re-uses the dir
 * without rewriting ownership, and a genuine collision moves to a new dir
 * instead of taking someone else's. Without that rule a short-lived helper
 * left a LIVE session's dir marked with its own dead pid, which makes the dir
 * immediately eligible for `scratch clear --all`.
 *
 * All creation is best-effort and never breaks spawn: failures are logged and
 * reported as `undefined`, and callers degrade to "no scratch dir".
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, SCRATCH_ROOT_INHERITED_ENV } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { getTaskIsolationSegment } from "./worktree";
import {
	isPidAlive,
	readTaskIsolationOwner,
	resolveScratchRootLogged,
	sweepOrphanedWorkspacesOnce,
	TASK_ISOLATION_OWNER_FILE,
} from "./worktree-gc";

/** Which run a scratch dir belongs to; selects the dir-name prefix. */
export type ScratchKind = "task" | "session";

const SCRATCH_DIR_PREFIX: Record<ScratchKind, string> = { task: "t", session: "s" };

/** Hex chars of the dir-name digest, matching the task-isolation segment width. */
const SCRATCH_DIGEST_CHARS = 9;

/**
 * Attempts to find an unclaimed dir before giving up. Only a digest collision
 * against a live owner costs an attempt, so anything past the first is already
 * a ~2^-36 event; the bound exists so a pathological environment degrades to
 * "no scratch dir" instead of spinning.
 */
const SCRATCH_CLAIM_ATTEMPTS = 4;

/**
 * Env var naming the scratch ROOT (`~/.loom/scratch`), read by
 * {@link getScratchDir}. Exported into a run's tool env so a nested loom
 * agrees with its parent about where the fleet's scratch lives.
 */
export const SCRATCH_ROOT_ENV = "OMP_SCRATCH_DIR";

/**
 * Env var naming THIS run's own scratch dir. Deliberately distinct from
 * {@link SCRATCH_ROOT_ENV}: one name for both meanings made every nested loom
 * treat the running agent's dir as a root full of disposable workspaces, so
 * starting one swept the agent's `tmp/` and `scratch clear --all` deleted its
 * work product.
 */
export const SCRATCH_RUN_DIR_ENV = "OMP_RUN_SCRATCH";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Re-assert that a previously created scratch dir (and its `tmp` subdir)
 * exists. Used by the subagent revive path: a swept or externally removed dir
 * must not break the revived session — the prompt names it, so it must be
 * there. Deliberately never touches `owner.json`: a revive re-asserts the
 * directory, it does not re-claim ownership. Best-effort; never throws.
 */
export async function assertScratchDir(baseDir: string): Promise<void> {
	try {
		await fs.mkdir(path.join(baseDir, "tmp"), { recursive: true });
	} catch (err) {
		logger.warn("scratch dir re-assert failed", { baseDir, error: errorMessage(err) });
	}
}

/** Owner marker as scratch writes it: the shared schema plus scratch's run fields. */
interface ScratchOwnerMarker {
	pid: number;
	startedAt: string;
	repoRoot: string;
	taskId: string;
	runId: string;
	worktree: string;
}

/** What claiming a dir's owner marker did. */
type ScratchClaim =
	/** The marker now names this process. */
	| "claimed"
	/** Another live process owns the dir, but it is the same run — share it. */
	| "shared"
	/** Another live run owns the dir; this run must go elsewhere. */
	| "conflict";

/**
 * Write the owner marker unless a LIVE foreign owner already holds the dir.
 * Create-exclusive first so two racing runs cannot both believe they claimed
 * it; the read-then-overwrite fallback only runs against a marker that is
 * already dead or unreadable, where the loser of a race takes a dir nobody is
 * using.
 */
async function claimScratchDir(baseDir: string, marker: ScratchOwnerMarker): Promise<ScratchClaim> {
	const markerPath = path.join(baseDir, TASK_ISOLATION_OWNER_FILE);
	const body = JSON.stringify(marker);
	try {
		await fs.writeFile(markerPath, body, { flag: "wx" });
		return "claimed";
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
			// Unwritable marker: the dir is still usable, it just cannot be
			// attributed. Never fail a spawn over it.
			logger.warn("scratch owner marker write failed", { baseDir, error: errorMessage(err) });
			return "shared";
		}
	}
	const existing = await readTaskIsolationOwner(baseDir);
	if (existing !== null && isPidAlive(existing.pid) && existing.pid !== process.pid) {
		// Same run, different process: a resume or a same-session helper such
		// as `sync-context --resume`. It gets the dir; the live owner keeps the
		// marker, because a helper that exits first would otherwise leave a
		// live session's dir looking abandoned.
		if (existing.runId !== undefined && existing.runId === marker.runId) return "shared";
		return "conflict";
	}
	try {
		await fs.writeFile(markerPath, body);
		return "claimed";
	} catch (err) {
		logger.warn("scratch owner marker write failed", { baseDir, error: errorMessage(err) });
		return "shared";
	}
}

/**
 * Create (or re-assert) the scratch dir for one run and write its owner
 * marker. Returns the absolute dir path, or `undefined` when creation failed
 * (best-effort — a failed scratch dir must never break a spawn).
 *
 * Task dirs are unique per call by construction: two spawns of the same agent
 * name in the same repo get different dirs even when they run concurrently in
 * different processes. Session dirs are stable for a given session id, so a
 * resume returns the same dir.
 */
export async function ensureScratchDir(cwd: string, id: string, kind: ScratchKind): Promise<string | undefined> {
	try {
		// The worktree digest keys on the git repo root; scratch keys on the
		// same value. Outside a checkout the resolved cwd stands in — scratch
		// exists for non-repo runs too.
		const repoRoot = (await git.repo.root(cwd)) ?? path.resolve(cwd);
		const root = resolveScratchRootLogged().path;
		const worktree = getTaskIsolationSegment(repoRoot, id);
		// A session id already identifies exactly one run and survives resumes;
		// an agent name identifies none, so every task spawn mints its own.
		let runId = kind === "session" ? id : Bun.randomUUIDv7();
		for (let attempt = 1; attempt <= SCRATCH_CLAIM_ATTEMPTS; attempt++) {
			const key = `${repoRoot}\0${kind}\0${id}\0${runId}`;
			const digest = Bun.hash(key).toString(16).padStart(16, "0").slice(-SCRATCH_DIGEST_CHARS);
			const baseDir = path.join(root, `${SCRATCH_DIR_PREFIX[kind]}${digest}`);
			await fs.mkdir(path.join(baseDir, "tmp"), { recursive: true });
			const claim = await claimScratchDir(baseDir, {
				pid: process.pid,
				startedAt: new Date().toISOString(),
				repoRoot,
				taskId: id,
				runId,
				worktree,
			});
			if (claim !== "conflict") {
				sweepOrphanedWorkspacesOnce();
				return baseDir;
			}
			logger.warn("scratch dir already held by a live run, retrying with a new run id", { baseDir, attempt });
			runId = Bun.randomUUIDv7();
		}
		logger.warn("scratch dir creation gave up after repeated live-owner collisions", { cwd, id, kind });
		return undefined;
	} catch (err) {
		logger.warn("scratch dir creation failed", { cwd, id, kind, error: errorMessage(err) });
		return undefined;
	}
}

/**
 * Tool-env entries routing a run's disposable writes into its scratch dir.
 *
 * `OMP_RUN_SCRATCH` names THIS run's dir for scripts; `OMP_SCRATCH_DIR` names
 * the scratch ROOT so a nested loom inherits the same fleet view (and so
 * `loom scratch list` inside an agent shell reports the fleet, not the agent's
 * own `tmp/`). `TMPDIR` (when `tmpdirRedirect` is on) routes `mktemp`,
 * `tempfile`, and library temp defaults into owned, GC'd space with zero model
 * cooperation. Returns `undefined` when the run has no scratch dir.
 */
export function buildScratchToolEnv(
	scratchDir: string | undefined,
	tmpdirRedirect: boolean,
): Record<string, string> | undefined {
	if (!scratchDir) return undefined;
	const root = resolveScratchRootLogged().path;
	const env: Record<string, string> = {
		[SCRATCH_ROOT_ENV]: root,
		// Marks the root as loom-injected rather than caller-chosen, so a
		// destructive `scratch clear --all` run from inside an agent shell
		// still faces the confirmation gate instead of inheriting consent.
		[SCRATCH_ROOT_INHERITED_ENV]: root,
		[SCRATCH_RUN_DIR_ENV]: scratchDir,
	};
	if (tmpdirRedirect) env.TMPDIR = path.join(scratchDir, "tmp");
	return env;
}
