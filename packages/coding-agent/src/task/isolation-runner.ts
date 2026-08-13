/**
 * Reusable isolation lifecycle for subagent execution.
 *
 * Both `TaskTool` and the eval `agent()` bridge spawn subagents that can run
 * inside a copy-on-write worktree, capture their changes, and (optionally)
 * apply those changes back to the parent repo. The orchestration is identical
 * for both callers; this module hosts the shared lifecycle so eval `agent()`
 * does not need to round-trip through `TaskTool.#runSpawn`.
 *
 * Shape:
 *   1. {@link prepareIsolationContext} — resolve git root + capture baseline.
 *   2. {@link runIsolatedSubprocess}    — start worktree, run, capture
 *                                        branch/patch, tear worktree down.
 *   3. {@link mergeIsolatedChanges}     — apply captured changes back to the
 *                                        parent repo (skip when the caller
 *                                        opted out).
 *
 * Step 1 happens once per top-level call (the baseline is cloned per spawn
 * before mutation); steps 2 and 3 are per-spawn.
 */
import * as path from "node:path";
import type * as natives from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import * as git from "../utils/git";
import type { ExecutorOptions } from "./executor";
import { runSubprocess } from "./executor";
import type { IgnoredChangeReport, IsolationCaptureFailure, SingleResult } from "./types";
import {
	applyNestedPatches,
	captureBaseline,
	captureDeltaPatch,
	captureIgnoredChanges,
	cleanupIsolation,
	cleanupTaskBranches,
	commitToBranch,
	ensureIsolation,
	getRepoRoot,
	type RepoRootOptions,
	type IgnoredChangeScan,
	type IsolationHandle,
	mergeTaskBranches,
	type NestedRepoPatch,
	type WorktreeBaseline,
	type BuildArtifactLinkMode,
} from "./worktree";

type IsoBackendKind = natives.IsoBackendKind;

/** Resolved repo + baseline used by every isolated spawn in a single call. */
export interface IsolationContext {
	repoRoot: string;
	baseline: WorktreeBaseline;
}

/**
 * Resolve the git repo root and capture the worktree baseline used to diff
 * each isolated spawn against. When `cwd` is not itself a checkout the root is
 * recovered from `options.configuredRoot` (`task.isolation.repoRoot`) or from a
 * single unambiguous child checkout; otherwise this throws and callers surface
 * the error as a task-tool failure.
 */
export async function prepareIsolationContext(cwd: string, options: RepoRootOptions = {}): Promise<IsolationContext> {
	const repoRoot = await getRepoRoot(cwd, options);
	const baseline = await captureBaseline(repoRoot);
	return { repoRoot, baseline };
}

/** Build a commit-message callback for branch/nested commits; `undefined` ⇒ fall back to generic message. */
export type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

/**
 * Construct the commit-message factory used by isolation branch commits and
 * nested-repo patch commits. Returns a closure that, each time it's called,
 * either yields an AI-backed `(diff) => Promise<string|null>` callback (when
 * `task.isolation.commits === "ai"` and a model registry is available) or
 * `undefined` so the caller falls back to a generic commit message.
 *
 * Centralized so `TaskTool` and the eval `agent()` bridge share one wiring;
 * a drift here previously meant the two callers built subtly different
 * generators for the same setting.
 */
export function makeIsolationCommitMessage(session: ToolSession): BuildCommitMessage {
	return () => {
		const style = session.settings.get("task.isolation.commits");
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

export interface IsolatedRunOptions {
	/**
	 * Base run options handed to the subagent subprocess. This helper sets
	 * `worktree`, clears `preloadedExtensionPaths` / `preloadedCustomToolPaths`
	 * (isolated runs re-discover inside the worktree), and forwards everything
	 * else unchanged.
	 */
	baseOptions: ExecutorOptions;
	/** Context returned by {@link prepareIsolationContext}. Baseline is cloned per spawn. */
	context: IsolationContext;
	/** PAL backend hint from `parseIsolationMode(...)` (undefined ⇒ resolver picks). */
	preferredBackend: IsoBackendKind | undefined;
	/** Stable id used as the isolation worktree namespace and as the branch suffix. */
	agentId: string;
	/** How gitignored build outputs are inherited from the parent checkout. */
	linkBuildArtifacts?: BuildArtifactLinkMode;
	/** Repo-root-relative gitignored paths to seed from the parent checkout. */
	linkPaths?: readonly string[];
	/** Merge mode driving how changes are captured ("branch" commits, "patch" diffs). */
	mergeMode: "patch" | "branch";
	/** Output dir for `${agentId}.patch` artifacts (patch mode and branch-mode commit failures). */
	artifactsDir: string;
	/** Human description carried onto the branch commit (branch mode). */
	description?: string;
	/** Build a commit-message callback (`task.isolation.commits === "ai"`). */
	buildCommitMessage?: BuildCommitMessage;
	/**
	 * Construct a `SingleResult` when isolation setup throws — the caller has
	 * the full metadata (index, agent, assignment, modelOverride) needed to
	 * build a result shape consistent with their non-isolated path.
	 */
	buildFailureResult: (err: unknown) => SingleResult;
}

async function writeIsolationPatch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	artifactsDir: string,
	agentId: string,
): Promise<{ patchPath: string; nestedPatches: NestedRepoPatch[] }> {
	const delta = await captureDeltaPatch(isolationDir, baseline);
	const patchPath = path.join(artifactsDir, `${agentId}.patch`);
	await Bun.write(patchPath, delta.rootPatch);
	return { patchPath, nestedPatches: delta.nestedPatches };
}

/** Status lines kept in a recovery note; enough to identify the work, not a full diff. */
const CAPTURE_FAILURE_STATUS_LINES = 200;
/** Per-file ceiling for copying a diverging ignored file aside. */
const IGNORED_PRESERVE_MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Total ceiling for one run's preserved ignored files. */
const IGNORED_PRESERVE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Record everything still recoverable about a run whose changes could not be
 * captured, and hand back the structured failure.
 *
 * The old path threw out of {@link writeIsolationPatch} before
 * `Bun.write(patchPath)`, and `runIsolatedSubprocess`'s `finally` then deleted
 * the isolation worktree — a successful subagent's entire change set gone, with
 * "merge failed" as the only trace. The worktree is kept (see
 * {@link runIsolatedSubprocess}) and this note names it plus the real cause and
 * the file list, so a human can finish the merge by hand.
 */
async function recordCaptureFailure(
	err: unknown,
	isolationDir: string,
	artifactsDir: string,
	agentId: string,
): Promise<IsolationCaptureFailure> {
	const reason = err instanceof Error ? err.message : String(err);
	const notePath = path.join(artifactsDir, `${agentId}.capture-failed.txt`);
	let status = "";
	try {
		status = (await git.status(isolationDir, { untrackedFiles: "all" }))
			.split("\n")
			.slice(0, CAPTURE_FAILURE_STATUS_LINES)
			.join("\n");
	} catch (statusErr) {
		status = `(could not list changed files: ${statusErr instanceof Error ? statusErr.message : String(statusErr)})`;
	}
	try {
		await Bun.write(
			notePath,
			[
				`Isolated task ${agentId} finished successfully, but its changes could not be captured as a patch.`,
				"",
				`Cause: ${reason}`,
				`Isolation worktree (kept for manual recovery, swept by the isolation GC once this process exits): ${isolationDir}`,
				"",
				"git status of the isolation worktree:",
				status,
				"",
			].join("\n"),
		);
		return { reason, isolationDir, notePath };
	} catch (writeErr) {
		logger.warn("isolation capture-failure note could not be written", {
			notePath,
			error: writeErr instanceof Error ? writeErr.message : String(writeErr),
		});
		return { reason, isolationDir };
	}
}

/**
 * Compare the isolation copy's ignored files against the parent repo, copy the
 * diverging ones beside the task artifacts, and return the report the parent
 * surfaces. `undefined` means "nothing ignored diverged" — the common case, and
 * the only case that stays silent.
 */
async function collectIgnoredChanges(
	isolationDir: string,
	repoRoot: string,
	artifactsDir: string,
	agentId: string,
	linkedArtifacts?: readonly string[],
): Promise<IgnoredChangeReport | undefined> {
	let scan: IgnoredChangeScan;
	try {
		scan = await captureIgnoredChanges(isolationDir, repoRoot, { skipLinkedArtifacts: linkedArtifacts });
	} catch (err) {
		logger.warn("ignored-file scan failed", {
			isolationDir,
			error: err instanceof Error ? err.message : String(err),
		});
		return { changes: [], unscanned: ["."], notPreserved: [] };
	}
	if (scan.changes.length === 0 && scan.unscanned.length === 0) return undefined;

	const preservedDir = path.join(artifactsDir, `${agentId}.ignored`);
	const notPreserved: string[] = [];
	let preservedBytes = 0;
	let preservedCount = 0;
	for (const change of scan.changes) {
		if (change.status === "removed") continue;
		if (
			change.bytes > IGNORED_PRESERVE_MAX_FILE_BYTES ||
			preservedBytes + change.bytes > IGNORED_PRESERVE_MAX_TOTAL_BYTES
		) {
			notPreserved.push(change.relativePath);
			continue;
		}
		try {
			await Bun.write(
				path.join(preservedDir, change.relativePath),
				Bun.file(path.join(isolationDir, change.relativePath)),
			);
			preservedBytes += change.bytes;
			preservedCount += 1;
		} catch (err) {
			logger.warn("diverging ignored file could not be preserved", {
				relativePath: change.relativePath,
				error: err instanceof Error ? err.message : String(err),
			});
			notPreserved.push(change.relativePath);
		}
	}
	return {
		changes: scan.changes,
		unscanned: scan.unscanned,
		notPreserved,
		...(preservedCount > 0 ? { preservedDir } : {}),
	};
}

/**
 * Run a subagent inside an isolation worktree and capture its changes.
 *
 * Branch mode: on success, commits the diff onto `omp/task/${agentId}` and
 * returns `branchName` + `nestedPatches`. On commit failure the branch is
 * deleted, the still-live isolation diff is written to `${artifactsDir}/${agentId}.patch`,
 * and `result.error` carries the merge-failure message.
 *
 * Patch mode: on success, writes `${artifactsDir}/${agentId}.patch` and
 * returns `patchPath` + `nestedPatches`.
 *
 * Failure paths preserve the underlying `SingleResult` whenever possible so
 * the caller can still surface the subagent's output; only isolation setup
 * itself routes through {@link IsolatedRunOptions.buildFailureResult}.
 *
 * The isolation handle is torn down in `finally` — EXCEPT when a successful run
 * could not be captured at all. That worktree holds the only copy of the work,
 * so it is kept and named in {@link SingleResult.captureFailure}; deleting it
 * was the difference between a recoverable failure and silent total loss.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<SingleResult> {
	let handle: IsolationHandle | undefined;
	let keepIsolationDir = false;
	try {
		const taskBaseline = structuredClone(opts.context.baseline);
		handle = await ensureIsolation(opts.context.repoRoot, opts.agentId, opts.preferredBackend, {
			linkBuildArtifacts: opts.linkBuildArtifacts,
			linkPaths: opts.linkPaths,
		});
		const isolationDir = handle.mergedDir;
		const result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedCustomToolPaths: undefined,
		});
		if (result.exitCode !== 0) return result;

		// Ignored paths are outside git's view entirely, so this is the only
		// place their divergence can still be observed — before teardown, and
		// regardless of which merge mode captured the tracked side.
		const ignoredChanges = await collectIgnoredChanges(
			isolationDir,
			opts.context.repoRoot,
			opts.artifactsDir,
			opts.agentId,
			handle.linkedArtifacts,
		);
		const ignored = ignoredChanges ? { ignoredChanges } : {};

		if (opts.mergeMode === "branch") {
			try {
				const commitResult = await commitToBranch(
					isolationDir,
					taskBaseline,
					opts.agentId,
					opts.description,
					opts.buildCommitMessage?.(),
				);
				return {
					...result,
					...ignored,
					branchName: commitResult?.branchName,
					branchBaseSha: commitResult?.baseSha,
					nestedPatches: commitResult?.nestedPatches,
				};
			} catch (mergeErr) {
				// Agent succeeded but branch commit failed — clean up stale branch
				const branchName = `omp/task/${opts.agentId}`;
				await git.branch.tryDelete(opts.context.repoRoot, branchName);
				const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
				try {
					const patchResult = await writeIsolationPatch(
						isolationDir,
						taskBaseline,
						opts.artifactsDir,
						opts.agentId,
					);
					return {
						...result,
						...ignored,
						patchPath: patchResult.patchPath,
						nestedPatches: patchResult.nestedPatches,
						error: `Merge failed: ${msg}`,
					};
				} catch (patchErr) {
					keepIsolationDir = true;
					const failure = await recordCaptureFailure(patchErr, isolationDir, opts.artifactsDir, opts.agentId);
					return {
						...result,
						...ignored,
						captureFailure: failure,
						error: `Merge failed: ${msg}; patch capture failed: ${failure.reason}`,
					};
				}
			}
		}
		try {
			const patchResult = await writeIsolationPatch(isolationDir, taskBaseline, opts.artifactsDir, opts.agentId);
			return {
				...result,
				...ignored,
				patchPath: patchResult.patchPath,
				nestedPatches: patchResult.nestedPatches,
			};
		} catch (patchErr) {
			keepIsolationDir = true;
			const failure = await recordCaptureFailure(patchErr, isolationDir, opts.artifactsDir, opts.agentId);
			return { ...result, ...ignored, captureFailure: failure, error: `Patch capture failed: ${failure.reason}` };
		}
	} catch (err) {
		return opts.buildFailureResult(err);
	} finally {
		if (handle && !keepIsolationDir) {
			await cleanupIsolation(handle);
		}
	}
}

export interface IsolationMergeOptions {
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
}

export interface IsolationMergeOutcome {
	/** Trailing summary appended to the subagent's result text. May be empty. */
	summary: string;
	/**
	 * Tri-state apply outcome:
	 * - `true`  — merge ran (or had nothing to apply) and left the repo clean.
	 * - `false` — merge attempted and failed; artifacts are preserved.
	 * - `null`  — caller skipped the merge phase entirely (e.g. `apply=false`).
	 */
	changesApplied: boolean | null;
	hadAnyChanges: boolean;
	/** True iff the root branch actually merged — gates nested-repo patch application. */
	mergedBranchForNestedPatches: boolean;
}

/** Diverging ignored paths listed by name in the summary before it switches to a count. */
const IGNORED_SUMMARY_MAX_NAMES = 20;

/**
 * Render the ignored-divergence report as a notification, or `""` when there is
 * nothing to say. Named paths are the whole point — "some files were not
 * merged" is the defect, not the fix.
 */
function formatIgnoredChanges(report: IgnoredChangeReport | undefined): string {
	if (!report) return "";
	const lines: string[] = [];
	if (report.changes.length > 0) {
		lines.push(
			"Gitignored paths changed inside the isolation worktree and were NOT merged (the capture path is git-only):",
		);
		for (const change of report.changes.slice(0, IGNORED_SUMMARY_MAX_NAMES)) {
			lines.push(`- ${change.relativePath} (${change.status})`);
		}
		if (report.changes.length > IGNORED_SUMMARY_MAX_NAMES) {
			lines.push(`- …and ${report.changes.length - IGNORED_SUMMARY_MAX_NAMES} more`);
		}
	}
	if (report.preservedDir) lines.push(`Copies preserved in: ${report.preservedDir}`);
	if (report.notPreserved.length > 0) lines.push(`Not copied aside: ${report.notPreserved.join(", ")}`);
	if (report.unscanned.length > 0) {
		lines.push(`Ignored-path comparison was incomplete under: ${report.unscanned.join(", ")}`);
	}
	if (lines.length === 0) return "";
	return `\n\n<system-notification>${lines.join("\n")}</system-notification>`;
}

/**
 * Report a run whose work could not be captured: the real cause, the retained
 * worktree, and the recovery note. Pre-fix the parent saw "Merge failed" with no
 * reason and no surviving artifact.
 */
function formatCaptureFailure(failure: IsolationCaptureFailure): string {
	const note = failure.notePath ? `\nRecovery note: ${failure.notePath}` : "";
	return `\n\n<system-notification>The subagent succeeded but its changes could not be captured: ${failure.reason}\nNothing was applied to the repo. The isolation worktree was KEPT so the work can be recovered by hand: ${failure.isolationDir}${note}</system-notification>`;
}

/**
 * Apply the tracked changes captured by {@link runIsolatedSubprocess}: patch
 * apply (patch mode) or cherry-pick + cleanup (branch mode). Ignored-path
 * divergence and capture failures are handled by {@link mergeIsolatedChanges}
 * around it, since neither has anything to apply.
 */
async function applyIsolationMerge(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const { result, repoRoot, mergeMode } = opts;
	try {
		if (mergeMode === "branch") {
			if (!result.branchName && result.exitCode === 0 && !result.aborted && result.error) {
				const patchList = result.patchPath ? `\nPatch artifact:\n- ${result.patchPath}` : "";
				return {
					summary: `\n\n<system-notification>Branch merge failed before a task branch could be created: ${result.error}\nTask outputs are preserved but changes were not applied.${patchList}</system-notification>`,
					changesApplied: false,
					hadAnyChanges: false,
					mergedBranchForNestedPatches: false,
				};
			}
			const canApplyNestedOnly =
				!result.branchName && result.exitCode === 0 && !result.aborted && (result.nestedPatches?.length ?? 0) > 0;
			if (!result.branchName || result.exitCode !== 0 || result.aborted) {
				return {
					summary: canApplyNestedOnly
						? "\n\nNo root changes to apply; nested repository patches captured."
						: "\n\nNo changes to apply.",
					changesApplied: true,
					hadAnyChanges: canApplyNestedOnly,
					mergedBranchForNestedPatches: canApplyNestedOnly,
				};
			}
			const mergeResult = await mergeTaskBranches(repoRoot, [
				{
					branchName: result.branchName,
					taskId: result.id,
					description: result.description,
					baseSha: result.branchBaseSha,
				},
			]);
			const mergedBranchForNestedPatches = mergeResult.merged.includes(result.branchName);
			const changesApplied = mergeResult.failed.length === 0;
			const hadAnyChanges = changesApplied && mergeResult.merged.length > 0;

			let summary: string;
			if (changesApplied) {
				summary = hadAnyChanges ? `\n\nMerged branch: ${result.branchName}` : "\n\nNo changes to apply.";
			} else {
				const conflictPart = mergeResult.conflict ? `\nConflict: ${mergeResult.conflict}` : "";
				summary = `\n\n<system-notification>Branch merge failed: ${result.branchName}.${conflictPart}\nThe unmerged branch remains for manual resolution.</system-notification>`;
			}
			if (mergeResult.stashConflict) {
				summary += `\n\n<system-notification>${mergeResult.stashConflict}</system-notification>`;
			}

			// Clean up the merged branch (keep failed ones for manual resolution)
			if (changesApplied) {
				await cleanupTaskBranches(repoRoot, [result.branchName]);
			}
			return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches };
		}

		// Patch mode: apply the patch from a successful run. A failed or
		// aborted run has nothing to apply and must not block the result.
		let changesApplied: boolean;
		let hadAnyChanges: boolean;
		const succeeded = result.exitCode === 0 && !result.error && !result.aborted;
		if (!succeeded) {
			changesApplied = true;
			hadAnyChanges = false;
		} else if (!result.patchPath) {
			changesApplied = false;
			hadAnyChanges = false;
		} else {
			const patchText = await Bun.file(result.patchPath).text();
			if (!patchText.trim()) {
				changesApplied = true;
				hadAnyChanges = false;
			} else {
				const normalized = patchText.endsWith("\n") ? patchText : `${patchText}\n`;
				// Idempotence: declare a no-op only when the reverse patch applies AND
				// the forward patch does not. `--reverse --check` alone can theoretically
				// succeed if the file happens to carry the postimage at another location
				// via git-apply's fuzz factor; requiring the forward check to fail
				// removes that ambiguity while still catching true already-applied
				// runs. Reads only — neither call touches the worktree, unlike
				// `--3way --check`, which exits 0 even when the real apply would
				// leave conflict markers and unmerged index entries.
				const [alreadyApplied, forwardApplies] = await Promise.all([
					git.patch.canApplyText(repoRoot, normalized, { reverse: true }),
					git.patch.canApplyText(repoRoot, normalized),
				]);
				hadAnyChanges = false;
				if (alreadyApplied && !forwardApplies) {
					changesApplied = true;
				} else if (forwardApplies) {
					changesApplied = true;
					try {
						await git.patch.applyText(repoRoot, normalized);
						hadAnyChanges = true;
					} catch {
						changesApplied = false;
					}
				} else {
					changesApplied = false;
				}
			}
		}

		let summary: string;
		if (changesApplied) {
			summary = hadAnyChanges ? "\n\nApplied patches: yes" : "\n\nNo changes to apply.";
		} else {
			const notification =
				"<system-notification>Patches were not applied and must be handled manually.</system-notification>";
			const patchList = result.patchPath ? `\n\nPatch artifact:\n- ${result.patchPath}` : "";
			summary = `\n\n${notification}${patchList}`;
		}
		return { summary, changesApplied, hadAnyChanges, mergedBranchForNestedPatches: false };
	} catch (mergeErr) {
		const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
		return {
			summary: `\n\n<system-notification>Merge phase failed: ${msg}\nTask outputs are preserved but changes were not applied.</system-notification>`,
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
}

/**
 * Apply changes captured by {@link runIsolatedSubprocess} back to the parent
 * repo, then report what deliberately did not come back with them.
 *
 * The caller decides whether to run this at all — eval `agent()` with
 * `apply=False` skips this step and surfaces the patch artifact / branch name
 * instead.
 */
export async function mergeIsolatedChanges(opts: IsolationMergeOptions): Promise<IsolationMergeOutcome> {
	const ignoredSummary = formatIgnoredChanges(opts.result.ignoredChanges);
	// A run whose changes never became a patch has nothing to apply and must not
	// be reported as "no changes"; the retained worktree is the recovery path.
	if (opts.result.captureFailure) {
		return {
			summary: `${formatCaptureFailure(opts.result.captureFailure)}${ignoredSummary}`,
			changesApplied: false,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		};
	}
	const outcome = await applyIsolationMerge(opts);
	if (!ignoredSummary) return outcome;
	return { ...outcome, summary: `${outcome.summary}${ignoredSummary}` };
}

export interface NestedPatchApplyOptions {
	/** Subagent result carrying `nestedPatches`/`exitCode`/`aborted`. */
	result: SingleResult;
	repoRoot: string;
	mergeMode: "patch" | "branch";
	/** Parent merge outcome — patch mode skips nested apply when this is `false`. */
	changesApplied: boolean | null;
	/** Branch mode gates nested apply on whether the root branch merged. */
	mergedBranchForNestedPatches: boolean;
	/** Optional AI commit-message callback for nested commits; falls back to a generic message. */
	commitMessage?: (diff: string) => Promise<string | null>;
}

/**
 * Apply nested-repo patches after the parent merge phase. Centralizes the
 * three-way gate (exitCode/aborted, patch-mode failed parent, branch-mode
 * branch-merged) and the non-fatal failure handling so `TaskTool` and the
 * eval `agent()` bridge use one implementation.
 *
 * Returns a system-notification suffix to append to the parent merge summary,
 * or an empty string when nothing was applied or the nested apply succeeded.
 */
export async function applyEligibleNestedPatches(opts: NestedPatchApplyOptions): Promise<string> {
	const { result, repoRoot, mergeMode, changesApplied, mergedBranchForNestedPatches, commitMessage } = opts;
	if (mergeMode === "patch" && changesApplied === false) return "";
	const nestedPatches = result.nestedPatches ?? [];
	const eligible =
		nestedPatches.length > 0 &&
		result.exitCode === 0 &&
		!result.aborted &&
		(mergeMode !== "branch" || mergedBranchForNestedPatches);
	if (!eligible) return "";
	try {
		const warnings = await applyNestedPatches(repoRoot, nestedPatches, commitMessage);
		if (warnings.length === 0) return "";
		return `\n\n<system-notification>${warnings.join("\n")}</system-notification>`;
	} catch {
		// Nested patch failures are non-fatal to the parent merge.
		return "\n\n<system-notification>Some nested repository patches failed to apply.</system-notification>";
	}
}
