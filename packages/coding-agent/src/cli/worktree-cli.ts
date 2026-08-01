/**
 * CLI handler for `loom worktree` — list and clean up agent-managed worktrees.
 *
 * Layout under `~/.loom/wt/`:
 *
 *   - **PR-checkout worktrees** (`tools/gh.ts`): a regular git worktree dir
 *     containing a `.git` *file* that points back at
 *     `<parent-repo>/.git/worktrees/<name>/`.
 *   - **Task-isolation dirs** (`task/worktree.ts`): a wrapper dir with a
 *     compact `m` subdir mounted/cloned by `natives.isoStart`. Legacy `merged`
 *     subdirs are still recognized. These are ephemeral; `ensureIsolation`
 *     removes the base before re-creating it, so leftovers are crashed runs.
 *
 * Legacy entries from before the encoding change keep working because git still
 * tracks them by branch name. This command exists to GC them on demand.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreesDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import { classifyTaskIsolation } from "../task/worktree-gc";
import * as git from "../utils/git";

type WorktreeKind = "pr-checkout" | "task-isolation" | "empty" | "stray";

const TASK_ISOLATION_MOUNT_DIRS = ["m", "merged"] as const;

export interface WorktreeEntry {
	/** Absolute path to the worktree dir (or stray container) under `~/.loom/wt/`. */
	path: string;
	/** Classification of what we found on disk. */
	kind: WorktreeKind;
	/** Parent repo root, when this is a registered git worktree or an owned task-isolation dir. */
	parentRepo?: string;
	/** Branch name extracted from the parent's tracking file, when available. */
	branch?: string;
	/** Live owner of a task-isolation dir, from its owner.json marker. */
	owner?: { pid: number; startedAt: string };
	/** When set, the entry is unhealthy and `loom worktree clear` will remove it. */
	orphanReason?: string;
}

export interface ListWorktreesOptions {
	json: boolean;
}

export interface ClearWorktreesOptions {
	/** Remove every entry, including live PR-checkout worktrees. */
	all: boolean;
	/** Print what would be removed without touching the filesystem. */
	dryRun: boolean;
	/** Also prune stale `omp/task/*` branches (last commit older than 7 days) in affected repos. Default false. */
	taskBranches?: boolean;
	json: boolean;
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log(chalk.dim(`No agent-managed worktrees found under ${getWorktreesDir()}.`));
		return;
	}
	let live = 0;
	let orphaned = 0;
	for (const entry of entries) {
		const tag = entry.orphanReason ? chalk.yellow("orphaned") : chalk.green("live    ");
		const detail = formatEntryDetail(entry);
		console.log(`${tag}  ${entry.path}`);
		if (detail) console.log(`          ${chalk.dim(detail)}`);
		if (entry.orphanReason) orphaned += 1;
		else live += 1;
	}
	console.log(chalk.dim(`\n${live} live · ${orphaned} orphaned · ${entries.length} total`));
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<void> {
	const entries = await scanWorktrees();
	const targets = options.all ? entries : entries.filter(entry => entry.orphanReason !== undefined);
	const parentsToPrune = new Set<string>();

	if (targets.length === 0) {
		if (options.json) {
			console.log(JSON.stringify({ removed: 0, kept: entries.length }));
		} else {
			console.log(chalk.dim(options.all ? "No worktrees to remove." : "No orphaned worktrees to remove."));
		}
	} else if (options.dryRun) {
		if (options.json) {
			console.log(JSON.stringify({ wouldRemove: targets.map(t => t.path) }, null, 2));
		} else {
			for (const target of targets) {
				console.log(`${chalk.yellow("would remove")}  ${target.path}`);
			}
			console.log(chalk.dim(`\n${targets.length} dir${targets.length === 1 ? "" : "s"} would be removed.`));
		}
	} else {
		const results: { path: string; ok: boolean; error?: string }[] = [];
		for (const target of targets) {
			try {
				if (target.kind === "pr-checkout" && target.parentRepo && !target.orphanReason) {
					// Live worktree: ask git to remove it cleanly. If git refuses (locked,
					// dirty, etc.), fall back to fs.rm and rely on `worktree prune` to
					// clean the bookkeeping on the parent side.
					const removed = await git.worktree.tryRemove(target.parentRepo, target.path, { force: true });
					if (!removed) {
						await fs.rm(target.path, { recursive: true, force: true });
						parentsToPrune.add(target.parentRepo);
					}
				} else {
					await fs.rm(target.path, { recursive: true, force: true });
					if (target.parentRepo) parentsToPrune.add(target.parentRepo);
				}
				results.push({ path: target.path, ok: true });
			} catch (err) {
				results.push({ path: target.path, ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		}

		// Best-effort: drop stale entries from each affected parent's `.git/worktrees/`.
		for (const parent of parentsToPrune) {
			try {
				await git.worktree.prune(parent);
			} catch {
				/* parent repo may already be gone or pruned — ignore */
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

	if (options.taskBranches) {
		const repos = new Set<string>(parentsToPrune);
		for (const entry of entries) {
			if (entry.parentRepo) repos.add(entry.parentRepo);
		}
		await pruneStaleTaskBranches(repos, options);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Scanner
// ───────────────────────────────────────────────────────────────────────────

async function scanWorktrees(): Promise<WorktreeEntry[]> {
	const root = getWorktreesDir();
	let topLevel: string[];
	try {
		topLevel = await fs.readdir(root);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}

	const entries: WorktreeEntry[] = [];
	for (const name of topLevel) {
		const dir = path.join(root, name);
		const stat = await fs.stat(dir).catch(() => null);
		if (!stat?.isDirectory()) continue;

		const direct = await classifyDir(dir);
		if (direct) {
			entries.push(direct);
			continue;
		}

		// Legacy nesting: ~/.loom/wt/<encoded-project>/<branch-or-id>
		let children: string[];
		try {
			children = await fs.readdir(dir);
		} catch {
			continue;
		}
		let nested = 0;
		for (const child of children) {
			const childDir = path.join(dir, child);
			const childStat = await fs.stat(childDir).catch(() => null);
			if (!childStat?.isDirectory()) continue;
			const childClassified = await classifyDir(childDir);
			if (childClassified) {
				entries.push(childClassified);
				nested += 1;
			}
		}
		if (nested === 0) {
			entries.push({
				path: dir,
				kind: children.length === 0 ? "empty" : "stray",
				orphanReason: children.length === 0 ? "empty directory" : "no recognizable worktree contents",
			});
		}
	}
	return entries;
}

async function classifyDir(dir: string): Promise<WorktreeEntry | null> {
	const gitEntry = path.join(dir, ".git");
	const gitStat = await fs.stat(gitEntry).catch(() => null);
	if (gitStat?.isFile()) {
		return classifyPrCheckout(dir, gitEntry);
	}
	for (const mountDir of TASK_ISOLATION_MOUNT_DIRS) {
		const mountStat = await fs.stat(path.join(dir, mountDir)).catch(() => null);
		if (!mountStat?.isDirectory()) continue;
		// Liveness-aware: dirs owned by a live process stay live; only dead-pid
		// or legacy leftovers past the grace window are orphaned.
		const classified = await classifyTaskIsolation(dir);
		const owner = classified.owner ? { pid: classified.owner.pid, startedAt: classified.owner.startedAt } : undefined;
		const parentRepo = classified.owner?.repoRoot;
		if (classified.orphaned) {
			return {
				path: dir,
				kind: "task-isolation",
				parentRepo,
				owner,
				orphanReason: classified.orphanReason ?? "task-isolation leftover (no live task owns it)",
			};
		}
		return { path: dir, kind: "task-isolation", parentRepo, owner };
	}
	return null;
}

async function classifyPrCheckout(dir: string, gitEntry: string): Promise<WorktreeEntry> {
	let contents: string;
	try {
		contents = await fs.readFile(gitEntry, "utf8");
	} catch (err) {
		return {
			path: dir,
			kind: "pr-checkout",
			orphanReason: `cannot read .git file: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
	const parentGitDir = match?.[1];
	if (!parentGitDir) {
		return { path: dir, kind: "pr-checkout", orphanReason: "malformed .git file (no gitdir line)" };
	}
	// parentGitDir is `<parent-repo>/.git/worktrees/<name>`; back out the repo root.
	const parentRepo = path.dirname(path.dirname(path.dirname(parentGitDir)));
	const branch = await readWorktreeBranch(path.join(parentGitDir, "HEAD"));

	const parentDirStat = await fs.stat(parentGitDir).catch(() => null);
	if (!parentDirStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo no longer tracks this worktree",
		};
	}
	const parentRepoStat = await fs.stat(parentRepo).catch(() => null);
	if (!parentRepoStat?.isDirectory()) {
		return {
			path: dir,
			kind: "pr-checkout",
			parentRepo,
			branch,
			orphanReason: "parent repo missing",
		};
	}
	return { path: dir, kind: "pr-checkout", parentRepo, branch };
}

async function readWorktreeBranch(headFile: string): Promise<string | undefined> {
	try {
		const head = (await fs.readFile(headFile, "utf8")).trim();
		const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
		return refMatch?.[1];
	} catch {
		return undefined;
	}
}

function formatEntryDetail(entry: WorktreeEntry): string {
	const parts: string[] = [];
	if (entry.kind === "pr-checkout") {
		const repo = entry.parentRepo ? path.basename(entry.parentRepo) : "unknown repo";
		const branch = entry.branch ?? "unknown branch";
		parts.push(`${repo} · ${branch}`);
	} else if (entry.kind === "task-isolation") {
		parts.push("task-isolation sandbox");
		if (entry.owner) parts.push(`owned by pid ${entry.owner.pid} since ${entry.owner.startedAt}`);
	} else if (entry.kind === "empty") {
		parts.push("legacy project shell");
	} else {
		parts.push("unrecognized contents");
	}
	if (entry.orphanReason) parts.push(entry.orphanReason);
	return parts.join(" — ");
}

// ───────────────────────────────────────────────────────────────────────────
// Stale task-branch pruning
// ───────────────────────────────────────────────────────────────────────────

/** Task branches created by task isolation (`task/worktree.ts`) use this prefix. */
const TASK_BRANCH_PREFIX = "omp/task/";
/** Branches whose last commit is older than this are considered stale. */
const TASK_BRANCH_STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface TaskBranch {
	name: string;
	committedAt: number;
}

/**
 * List `omp/task/*` branches with their last-commit timestamp. `git.branch.list`
 * has no date support, so this shells out to `for-each-ref` the same way
 * `utils/git.ts` spawns git. Returns [] when the repo is gone or git fails.
 */
async function listTaskBranches(repoRoot: string): Promise<TaskBranch[]> {
	const child = Bun.spawn(
		[
			"git",
			"for-each-ref",
			"--format=%(refname:short)%00%(committerdate:iso8601)",
			`refs/heads/${TASK_BRANCH_PREFIX}`,
		],
		{ cwd: repoRoot, stdout: "pipe", stderr: "ignore" },
	);
	const stdout = await new Response(child.stdout).text();
	const exitCode = await child.exited;
	if (exitCode !== 0) return [];
	const branches: TaskBranch[] = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const [name, date] = line.split("\0");
		if (!name || !date) continue;
		const committedAt = Date.parse(date);
		if (Number.isNaN(committedAt)) continue;
		branches.push({ name, committedAt });
	}
	return branches;
}

/** Delete `omp/task/*` branches older than TASK_BRANCH_STALE_MS in each repo. Best-effort per branch. */
async function pruneStaleTaskBranches(repos: Set<string>, options: ClearWorktreesOptions): Promise<void> {
	const cutoff = Date.now() - TASK_BRANCH_STALE_MS;
	for (const repo of repos) {
		let branches: TaskBranch[];
		try {
			branches = await listTaskBranches(repo);
		} catch {
			continue; // repo may already be gone
		}
		for (const branch of branches) {
			if (branch.committedAt >= cutoff) continue;
			if (options.dryRun) {
				if (!options.json) console.log(`${chalk.yellow("would delete branch")}  ${branch.name}  ${chalk.dim(`(${repo})`)}`);
				continue;
			}
			try {
				const deleted = await git.branch.tryDelete(repo, branch.name);
				if (!deleted) throw new Error("git branch -D exited non-zero");
				if (!options.json) console.log(`${chalk.green("deleted branch")}  ${branch.name}  ${chalk.dim(`(${repo})`)}`);
			} catch (err) {
				if (!options.json) {
					console.log(`${chalk.red("failed branch  ")}  ${branch.name}  ${chalk.dim(`(${repo})`)}`);
					console.log(`          ${chalk.dim(err instanceof Error ? err.message : String(err))}`);
				}
				process.exitCode = 1;
			}
		}
	}
}
