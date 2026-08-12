import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { getWorktreeDir, isEnoent, logger, Snowflake } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import * as jj from "../utils/jj";
import { mapWithConcurrencyLimit } from "./parallel";
import {
	type BuildArtifactLinkMode,
	linkParentBuildArtifacts,
	shouldSkipLinkedIgnoredEntry,
} from "./link-build-artifacts";
import { sweepOrphanedWorkspacesOnce, TASK_ISOLATION_OWNER_FILE } from "./worktree-gc";

export type { BuildArtifactLinkMode } from "./link-build-artifacts";

const { IsoBackendKind } = natives;

const TASK_ISOLATION_DIR_PREFIX = "t";
const TASK_ISOLATION_DIR_DIGEST_CHARS = 9;
const TASK_ISOLATION_MOUNT_DIR = "m";
type IsoBackendKind = natives.IsoBackendKind;

/** Baseline state for a single git repository. */
export interface RepoBaseline {
	repoRoot: string;
	headCommit: string;
	staged: string;
	unstaged: string;
	untracked: string[];
	untrackedPatch: string;
}

/** Baseline state for the project, including any nested git repos. */
export interface WorktreeBaseline {
	root: RepoBaseline;
	/** Nested git repos (path relative to root.repoRoot). */
	nested: Array<{ relativePath: string; baseline: RepoBaseline }>;
}

/** Options for {@link getRepoRoot}: how to recover when `cwd` itself is not a checkout. */
export interface RepoRootOptions {
	/** `task.isolation.repoRoot` — explicit checkout to isolate from. Relative values resolve against `cwd`. */
	configuredRoot?: string;
}

/** Cap on how many sibling checkouts are named in the ambiguous-container error. */
const REPO_CANDIDATE_SAMPLE = 8;

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return os.homedir() + p.slice(1);
	return p;
}

/**
 * Depth-1 scan for checkouts directly below `dir`. A container directory (the
 * classic `~/workspace`) holds the real repos as siblings, so this is what
 * distinguishes "nothing to isolate here" from "you are one level too high".
 * Resolved through git rather than a `.git` stat: `.git` may be a linked
 * worktree pointer, and a dead pointer is not a usable checkout.
 */
async function findChildRepos(dir: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const candidates = entries.filter(
		entry => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
	);
	const { results } = await mapWithConcurrencyLimit(candidates, 16, async entry =>
		git.repo.root(path.join(dir, entry.name)),
	);
	return [...new Set(results.filter((root): root is string => !!root))].sort();
}

export async function getRepoRoot(cwd: string, options: RepoRootOptions = {}): Promise<string> {
	// Pure-jj check runs first so a jj workspace nested under an unrelated
	// outer Git checkout is rejected at its own root rather than silently
	// mutating the surrounding Git tree behind jj's back.
	if (await jj.isPureJjRepo(cwd)) {
		throw new Error(
			"Isolated task execution requires a Git checkout, but this workspace is pure Jujutsu (`.jj/` without a colocated `.git/`). Run `jj git init --colocate` to add a Git checkout, or set `task.isolation.mode: none` to disable task isolation.",
		);
	}

	const repoRoot = await git.repo.root(cwd);
	if (repoRoot) return repoRoot;

	// `cwd` is not a checkout. Dead-ending here is what pushes agents into
	// hand-rolling `git worktree add` siblings inside the container directory,
	// so resolve the checkout the spawn is actually for before giving up.
	const configured = options.configuredRoot?.trim();
	if (configured) {
		const resolved = path.resolve(cwd, expandHome(configured));
		// A path that does not exist would make git itself fail to spawn (ENOENT
		// on the child cwd), surfacing as a mystery instead of "your setting is
		// wrong" — so establish the directory exists before asking git anything.
		const exists = await fs
			.stat(resolved)
			.then((s: Stats) => s.isDirectory())
			.catch(() => false);
		const configuredRepo = exists ? await git.repo.root(resolved) : null;
		// An explicit setting that misses is a misconfiguration, not licence to
		// guess: report it instead of silently falling through to inference.
		if (!configuredRepo) {
			throw new Error(
				`task.isolation.repoRoot (${configured}) is not inside a git repository. Point it at a checkout, or clear the setting.`,
			);
		}
		return configuredRepo;
	}

	const children = await findChildRepos(cwd);
	// Exactly one checkout below the directory is unambiguous. Two or more is a
	// real choice — sibling checkouts of one project are common, and picking by
	// heuristic would isolate against the wrong tree without ever saying so.
	if (children.length === 1) {
		logger.info(`task isolation: ${cwd} is not a checkout; using its only child repo ${children[0]}`);
		return children[0];
	}
	if (children.length > 1) {
		const sample = children.slice(0, REPO_CANDIDATE_SAMPLE).map(p => path.basename(p));
		const more = children.length > sample.length ? `, +${children.length - sample.length} more` : "";
		throw new Error(
			`Git repository not found for isolated task execution: ${cwd} is not a checkout, but contains ${children.length} of them (${sample.join(", ")}${more}). Isolation will not guess which one this spawn is for — pass \`cwd\` on the spawn (e.g. cwd: ${JSON.stringify(children[0])}), or set \`task.isolation.repoRoot\`.`,
		);
	}
	throw new Error(
		`Git repository not found for isolated task execution (cwd: ${cwd}). Start the session inside a checkout, pass \`cwd\` on the spawn, or set \`task.isolation.repoRoot\`.`,
	);
}

const GIT_NO_INDEX_NULL_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export function getGitNoIndexNullPath(): string {
	return GIT_NO_INDEX_NULL_PATH;
}

/** Find nested git repositories (non-submodule) under the given root. */
async function discoverNestedRepos(repoRoot: string): Promise<string[]> {
	// Get submodule paths so we can exclude them
	const submodulePaths = new Set(await git.ls.submodules(repoRoot));

	// Find all .git dirs/files that aren't the root or known submodules
	const result: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			const rel = path.relative(repoRoot, full);
			// Check if this directory is itself a git repo. A `.git` FILE is a
			// linked-worktree pointer; the checkout is usable only while its
			// `gitdir:` target exists. Deleting the primary/bare repo leaves a
			// dead pointer behind, and any git command run inside then dies with
			// an opaque `fatal: not a git repository: <dead path>` — which would
			// abort the entire isolation baseline for a repo that is not even
			// part of the parent's change surface. Treat dead pointers as absent.
			let hasGit = false;
			try {
				const gitEntry = path.join(full, ".git");
				const isPointerFile = (await fs.stat(gitEntry)).isFile();
				if (isPointerFile) {
					const pointer = (await fs.readFile(gitEntry, "utf8")).trim();
					const match = /^gitdir:\s*(.+)$/.exec(pointer);
					const target = match ? path.resolve(dir, match[1].trim()) : "";
					if (target) {
						try {
							await fs.access(target);
							hasGit = true;
						} catch {}
					}
				} else {
					hasGit = true;
				}
			} catch {}
			if (hasGit && !submodulePaths.has(rel)) {
				result.push(rel);
				// Don't recurse into nested repos — they manage their own tree
				continue;
			}
			await walk(full);
		}
	}
	await walk(repoRoot);
	return result;
}

/**
 * Diff every untracked file against `/dev/null` so it lands in the synthetic
 * baseline tree.
 *
 * Uses {@link git.diff.capture} rather than `git.diff`: a per-file diff that
 * outgrows the transcript-sized output ceiling comes back with a truncation
 * marker spliced in, and marker-bearing text is not a short patch — it is a
 * corrupt one that `git apply --cached` rejects several stack frames later,
 * after the isolation worktree has already been destroyed.
 */
async function captureUntrackedPatch(repoRoot: string, untracked: readonly string[]): Promise<string> {
	if (untracked.length === 0) return "";
	const nullPath = getGitNoIndexNullPath();
	// Bound concurrent git spawns; large untracked sets would otherwise fork one
	// process per file at once.
	const { results: untrackedDiffs } = await mapWithConcurrencyLimit([...untracked], 8, entry =>
		git.diff.capture(repoRoot, {
			allowFailure: true,
			binary: true,
			noIndex: { left: nullPath, right: entry },
		}),
	);
	return untrackedDiffs.filter((diff): diff is string => !!diff?.trim()).join("\n");
}

async function captureRepoBaseline(repoRoot: string): Promise<RepoBaseline> {
	const headCommit = (await git.head.sha(repoRoot)) ?? "";
	const staged = await git.diff.capture(repoRoot, { binary: true, cached: true });
	const unstaged = await git.diff.capture(repoRoot, { binary: true });
	const untracked = await git.ls.untracked(repoRoot);
	const untrackedPatch = await captureUntrackedPatch(repoRoot, untracked);
	return { repoRoot, headCommit, staged, unstaged, untracked, untrackedPatch };
}

/**
 * Bytes of a patch's tail scanned for the git truncation marker.
 *
 * The marker is always appended at the very end of a single capture, so the
 * tail is the only place it can legitimately appear. Scanning the whole patch
 * would also flag a diff that merely *quotes* the marker — loom's own sources
 * do — and refusing a valid change set is the failure this guard exists to
 * prevent.
 */
const PATCH_TRUNCATION_TAIL_SCAN_BYTES = 256;

function assertPatchIntact(patch: string, repoDir: string): void {
	if (!patch.slice(-PATCH_TRUNCATION_TAIL_SCAN_BYTES).includes(git.GIT_OUTPUT_TRUNCATED_MARKER_PREFIX)) return;
	throw new Error(
		`Isolation patch capture for ${repoDir} was truncated by the git output limit; refusing to build a tree from a corrupt patch.`,
	);
}

async function writeSyntheticTree(repoDir: string, baseTreeish: string, patches: readonly string[]): Promise<string> {
	const tempIndex = path.join(os.tmpdir(), `omp-task-index-${Snowflake.next()}`);
	try {
		await git.readTree(repoDir, baseTreeish, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
		for (const patch of patches) {
			if (!patch.trim()) continue;
			assertPatchIntact(patch, repoDir);
			await git.patch.applyText(repoDir, patch, {
				cached: true,
				env: { GIT_INDEX_FILE: tempIndex },
			});
		}
		return await git.writeTree(repoDir, {
			env: { GIT_INDEX_FILE: tempIndex },
		});
	} finally {
		await fs.rm(tempIndex, { force: true });
	}
}

export async function captureBaseline(repoRoot: string): Promise<WorktreeBaseline> {
	const [root, nestedPaths] = await Promise.all([captureRepoBaseline(repoRoot), discoverNestedRepos(repoRoot)]);
	// A nested checkout that cannot be read — dead worktree pointer, lost
	// permissions, vanished gitdir — must not abort the whole fan-out. Its
	// changes are not part of the parent repo's change surface, so dropping it
	// from the baseline is lossless; surface a warning instead of failing every
	// isolated spawn in the batch.
	const nested: WorktreeBaseline["nested"] = [];
	await Promise.all(
		nestedPaths.map(async relativePath => {
			try {
				nested.push({ relativePath, baseline: await captureRepoBaseline(path.join(repoRoot, relativePath)) });
			} catch (err) {
				logger.warn("isolation baseline skipped unreadable nested repo", {
					relativePath,
					error: errorMessage(err),
				});
			}
		}),
	);
	return { root, nested };
}

async function captureRepoDeltaPatch(repoDir: string, rb: RepoBaseline, objectRepoDir = repoDir): Promise<string> {
	const currentHead = (await git.head.sha(repoDir)) ?? "";
	const currentStaged = await git.diff.capture(repoDir, { binary: true, cached: true });
	const currentUnstaged = await git.diff.capture(repoDir, { binary: true });
	const currentUntracked = await git.ls.untracked(repoDir);
	const currentUntrackedPatch = await captureUntrackedPatch(repoDir, currentUntracked);
	const committedPatch =
		currentHead && currentHead !== rb.headCommit
			? await git.diff.captureTree(repoDir, rb.headCommit, currentHead, {
					allowFailure: true,
					binary: true,
				})
			: "";

	const baselineTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		rb.staged,
		rb.unstaged,
		rb.untrackedPatch,
	]);
	const currentTree = await writeSyntheticTree(objectRepoDir, rb.headCommit, [
		committedPatch,
		currentStaged,
		currentUnstaged,
		currentUntrackedPatch,
	]);

	return git.diff.captureTree(objectRepoDir, baselineTree, currentTree, {
		allowFailure: true,
		binary: true,
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Gitignored-file divergence
// ═══════════════════════════════════════════════════════════════════════════

/** How an ignored path differs between the isolation copy and the parent repo. */
export type IgnoredChangeStatus = "added" | "modified" | "removed";

/** One ignored path that does not match the parent repo. */
export interface IgnoredChange {
	/** Path relative to the isolation dir / repo root, POSIX-separated. */
	relativePath: string;
	status: IgnoredChangeStatus;
	/** Size in the isolation copy; 0 for `removed`. */
	bytes: number;
}

/**
 * Result of {@link captureIgnoredChanges}. `unscanned` exists so an incomplete
 * answer can never be read as a clean one.
 */
export interface IgnoredChangeScan {
	changes: IgnoredChange[];
	/** Paths whose comparison was cut short by the scan budget or an I/O error. */
	unscanned: string[];
}

/** Entry ceiling for one ignored-file scan; a runaway guard, not a policy. */
const IGNORED_SCAN_MAX_ENTRIES = 100_000;
/** Total bytes read while comparing ignored file contents in one scan. */
const IGNORED_SCAN_MAX_COMPARE_BYTES = 64 * 1024 * 1024;

interface IgnoredScanBudget {
	entries: number;
	compareBytes: number;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
	try {
		return await fs.lstat(target);
	} catch {
		return null;
	}
}

/** Byte-exact comparison of two files; `null` when the compare budget is spent. */
async function filesIdentical(
	left: string,
	right: string,
	size: number,
	budget: IgnoredScanBudget,
): Promise<boolean | null> {
	if (budget.compareBytes + size > IGNORED_SCAN_MAX_COMPARE_BYTES) return null;
	budget.compareBytes += size;
	try {
		const [a, b] = await Promise.all([Bun.file(left).bytes(), Bun.file(right).bytes()]);
		return a.length === b.length && Buffer.compare(a, b) === 0;
	} catch {
		return null;
	}
}

/**
 * Collect every file under `dir` as `relativePath -> lstat`. Returns `false`
 * when the entry budget or an I/O error cut the walk short, which the caller
 * reports as unscanned rather than treating a partial listing as the whole
 * truth. A directory that simply does not exist on this side is not a failure —
 * a build directory the agent created has no parent-side counterpart.
 */
async function collectTreeFiles(
	dir: string,
	prefix: string,
	budget: IgnoredScanBudget,
	out: Map<string, Stats>,
): Promise<boolean> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		return isEnoent(err);
	}
	for (const entry of entries) {
		if (budget.entries >= IGNORED_SCAN_MAX_ENTRIES) return false;
		budget.entries += 1;
		const full = path.join(dir, entry.name);
		const rel = `${prefix}${entry.name}`;
		if (entry.isDirectory()) {
			if (!(await collectTreeFiles(full, `${rel}/`, budget, out))) return false;
			continue;
		}
		const stats = await lstatOrNull(full);
		if (stats) out.set(rel, stats);
	}
	return true;
}

/**
 * Compare one ignored path that is a file or symlink in at least one tree.
 * Pushes into `changes`, `unscanned`, or neither (identical).
 */
async function compareIgnoredFile(
	relativePath: string,
	isolationPath: string,
	repoPath: string,
	left: Stats | null,
	right: Stats | null,
	exact: boolean,
	budget: IgnoredScanBudget,
	scan: IgnoredChangeScan,
): Promise<void> {
	if (!left) {
		if (right) scan.changes.push({ relativePath, status: "removed", bytes: 0 });
		return;
	}
	if (!right) {
		scan.changes.push({ relativePath, status: "added", bytes: left.size });
		return;
	}
	if (left.isSymbolicLink() || right.isSymbolicLink()) {
		const [a, b] = await Promise.all([
			fs.readlink(isolationPath).catch(() => null),
			fs.readlink(repoPath).catch(() => null),
		]);
		if (a !== b) scan.changes.push({ relativePath, status: "modified", bytes: left.size });
		return;
	}
	if (left.size !== right.size) {
		scan.changes.push({ relativePath, status: "modified", bytes: left.size });
		return;
	}
	// Equal size: only a content read can tell them apart. Inside a collapsed
	// ignored directory we deliberately stop here — see captureIgnoredChanges.
	if (!exact) return;
	const identical = await filesIdentical(isolationPath, repoPath, left.size, budget);
	if (identical === null) {
		scan.unscanned.push(relativePath);
		return;
	}
	if (!identical) scan.changes.push({ relativePath, status: "modified", bytes: left.size });
}

async function compareIgnoredDirectory(
	relativePath: string,
	isolationDir: string,
	repoRoot: string,
	budget: IgnoredScanBudget,
	scan: IgnoredChangeScan,
): Promise<void> {
	const left = new Map<string, Stats>();
	const right = new Map<string, Stats>();
	const prefix = `${relativePath}/`;
	const leftComplete = await collectTreeFiles(path.join(isolationDir, relativePath), prefix, budget, left);
	const rightComplete = await collectTreeFiles(path.join(repoRoot, relativePath), prefix, budget, right);
	if (!leftComplete || !rightComplete) {
		scan.unscanned.push(prefix);
		return;
	}
	for (const rel of new Set([...left.keys(), ...right.keys()])) {
		await compareIgnoredFile(
			rel,
			path.join(isolationDir, rel),
			path.join(repoRoot, rel),
			left.get(rel) ?? null,
			right.get(rel) ?? null,
			false,
			budget,
			scan,
		);
	}
}

/**
 * Compare the ignored files of an isolation copy against the parent repo.
 *
 * Isolation materialises the repo byte-for-byte, so `.env`, local config and
 * build output are all present and writable inside the copy — while the capture
 * path is pure git (`ls-files --others --exclude-standard`, `git diff`), and git
 * never reports an ignored path. Anything an agent writes there is invisible to
 * the merge and dies with the worktree.
 *
 * This does not merge those files: a path is ignored because the repo does not
 * want it versioned, and folding it into a commit or patch would be a worse
 * surprise than not merging it. It answers the honest question instead — WHICH
 * ignored paths diverged — so the caller can name them and keep a copy.
 *
 * Cost policy: ignored entries come from one `ls-files --directory` call, so a
 * wholly-ignored directory (`node_modules/`, `dist/`) is a single entry instead
 * of a hundred thousand. Ignored FILES are compared byte-exactly (size, then
 * contents, within {@link IGNORED_SCAN_MAX_COMPARE_BYTES}) — that is the
 * `.env`/local-config case this exists for. Inside a collapsed directory the
 * comparison is name, size and link target only: hashing a dependency tree on
 * every spawn costs far more than the answer is worth, and a same-size in-place
 * edit under an ignored build directory is the one case knowingly traded away.
 * Whatever the budget or an I/O error cut short is listed in `unscanned`.
 */
export async function captureIgnoredChanges(
	isolationDir: string,
	repoRoot: string,
	options?: { skipLinkedArtifacts?: readonly string[] },
): Promise<IgnoredChangeScan> {
	const scan: IgnoredChangeScan = { changes: [], unscanned: [] };
	const budget: IgnoredScanBudget = { entries: 0, compareBytes: 0 };
	let entries: string[];
	try {
		const [left, right] = await Promise.all([git.ls.ignoredEntries(isolationDir), git.ls.ignoredEntries(repoRoot)]);
		entries = [...new Set([...left, ...right])].sort();
	} catch (err) {
		logger.warn("ignored-file scan could not list ignored entries", {
			isolationDir,
			error: errorMessage(err),
		});
		scan.unscanned.push(".");
		return scan;
	}
	for (const entry of entries) {
		if (shouldSkipLinkedIgnoredEntry(entry, options?.skipLinkedArtifacts ?? [])) {
			continue;
		}
		if (entry.endsWith("/")) {
			await compareIgnoredDirectory(entry.slice(0, -1), isolationDir, repoRoot, budget, scan);
			continue;
		}
		await compareIgnoredFile(
			entry,
			path.join(isolationDir, entry),
			path.join(repoRoot, entry),
			await lstatOrNull(path.join(isolationDir, entry)),
			await lstatOrNull(path.join(repoRoot, entry)),
			true,
			budget,
			scan,
		);
	}
	scan.changes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	return scan;
}

export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
}

function unquoteGitDiffPath(rawPath: string): string {
	let value = rawPath;
	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			value = JSON.parse(value) as string;
		} catch {
			value = value.slice(1, -1);
		}
	}
	return value.replace(/^[ab]\//, "");
}

function parseDiffGitLinePaths(line: string): string[] {
	if (!line.startsWith("diff --git ")) return [];
	const rest = line.slice("diff --git ".length);
	const quoted = rest.match(/^("(?:\\.|[^"])+"|\/dev\/null) ("(?:\\.|[^"])+"|\/dev\/null)$/);
	const parts = quoted ? [quoted[1], quoted[2]] : rest.split(" ");
	if (parts.length < 2) return [];
	const paths = parts
		.slice(0, 2)
		.map(unquoteGitDiffPath)
		.filter(file => file && file !== "/dev/null");
	return [...new Set(paths)];
}

function patchTouchedFiles(patch: string): string[] {
	const files = new Set<string>();
	for (const line of patch.split("\n")) {
		for (const file of parseDiffGitLinePaths(line)) files.add(file);
	}
	return [...files];
}

export interface DeltaPatchResult {
	rootPatch: string;
	nestedPatches: NestedRepoPatch[];
}

export async function captureDeltaPatch(isolationDir: string, baseline: WorktreeBaseline): Promise<DeltaPatchResult> {
	const rootPatch = await captureRepoDeltaPatch(isolationDir, baseline.root, baseline.root.repoRoot);
	const nestedPatches: NestedRepoPatch[] = [];

	for (const { relativePath, baseline: nb } of baseline.nested) {
		const nestedDir = path.join(isolationDir, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}
		const patch = await captureRepoDeltaPatch(nestedDir, nb, nb.repoRoot);
		if (patch.trim()) nestedPatches.push({ relativePath, patch });
	}

	return { rootPatch, nestedPatches };
}

/**
 * Apply nested repo patches directly to their working directories after parent merge.
 *
 * Pre-existing dirty state in a nested repo is stashed before the patch is
 * applied and popped back (with `--index` so staged WIP stays staged) after
 * the commit, so unrelated user edits never get folded into the agent's
 * commit. A failing `git stash pop` (e.g. user edits collide with the patched
 * lines) leaves the stash entry intact, emits a `logger.warn`, and is
 * returned to the caller as a human-readable warning string — the agent
 * commit already landed, so this is a partial success the workflow needs to
 * see, not a thrown failure.
 *
 * Returns the collected stash-restore warnings (empty when every nested repo
 * was restored cleanly). Throws when the patch apply itself fails.
 *
 * @param commitMessage Optional async function to generate a commit message from the combined diff.
 *                      If omitted or returns null, falls back to a generic message.
 */
export async function applyNestedPatches(
	repoRoot: string,
	patches: NestedRepoPatch[],
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<string[]> {
	const warnings: string[] = [];
	// Group patches by target repo to apply all at once and commit
	const byRepo = new Map<string, NestedRepoPatch[]>();
	for (const p of patches) {
		if (!p.patch.trim()) continue;
		const group = byRepo.get(p.relativePath) ?? [];
		group.push(p);
		byRepo.set(p.relativePath, group);
	}

	for (const [relativePath, repoPatches] of byRepo) {
		const nestedDir = path.join(repoRoot, relativePath);
		try {
			await fs.access(path.join(nestedDir, ".git"));
		} catch {
			continue;
		}

		const combinedDiff = repoPatches.map(p => p.patch).join("\n");
		const touchedFiles = [...new Set(repoPatches.flatMap(p => patchTouchedFiles(p.patch)))];

		// Preserve any pre-existing dirty state (tracked + untracked) so we
		// commit only the agent delta, not the user's in-flight work.
		const stashed =
			(await git.status(nestedDir)).trim().length > 0
				? await git.stash.push(nestedDir, `omp-isolation-${Snowflake.next()}`)
				: false;
		try {
			for (const { patch } of repoPatches) {
				await git.patch.applyText(nestedDir, patch);
			}
			if ((await git.status(nestedDir)).trim().length > 0) {
				if (touchedFiles.length === 0) {
					throw new Error(`Nested repo patch for ${relativePath} did not include stageable file paths.`);
				}
				const msg = (await commitMessage?.(combinedDiff)) ?? "changes from isolated task(s)";
				await git.stage.files(nestedDir, touchedFiles);
				await git.commit(nestedDir, msg);
			}
		} finally {
			if (stashed) {
				const restored = await git.stash.tryPop(nestedDir, { index: true });
				if (!restored) {
					logger.warn("Pre-existing nested-repo dirty state could not be auto-restored", {
						nestedDir,
					});
					warnings.push(
						`Pre-existing dirty state in nested repo \`${relativePath}\` could not be auto-restored after the agent commit; stash entry preserved.`,
					);
				}
			}
		}
	}
	return warnings;
}

// ═══════════════════════════════════════════════════════════════════════════
// Unified isolation lifecycle — picks the best backend via the PAL and
// returns the merged-view path together with the resolved kind.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * User-facing isolation mode names exposed by the `task.isolation.mode`
 * setting. Mapped to a backend-kind hint via {@link parseIsolationMode};
 * the PAL's `iso_resolve` then falls back through the kind order
 * whenever the hint isn't available on the current host.
 */
export type TaskIsolationMode =
	| "none"
	| "auto"
	| "apfs"
	| "btrfs"
	| "zfs"
	| "reflink"
	| "overlayfs"
	| "projfs"
	| "block-clone"
	| "rcopy"
	// Legacy values, accepted for back-compat with pre-PAL settings files.
	| "worktree"
	| "fuse-overlay"
	| "fuse-projfs";

/**
 * Translate a {@link TaskIsolationMode} string to an [`IsoBackendKind`]
 * the PAL can act on. `"none"` returns `null` (caller skips isolation
 * entirely); `"auto"` returns `undefined` (no hint — let the resolver
 * pick). Anything else returns the matching kind.
 */
export function parseIsolationMode(mode: TaskIsolationMode): IsoBackendKind | undefined {
	switch (mode) {
		case "none":
		case "auto":
			return undefined;
		case "apfs":
			return IsoBackendKind.Apfs;
		case "btrfs":
			return IsoBackendKind.Btrfs;
		case "zfs":
			return IsoBackendKind.Zfs;
		case "reflink":
			return IsoBackendKind.LinuxReflink;
		case "overlayfs":
		case "fuse-overlay":
			return IsoBackendKind.Overlayfs;
		case "projfs":
		case "fuse-projfs":
			return IsoBackendKind.Projfs;
		case "block-clone":
			return IsoBackendKind.WindowsBlockClone;
		case "rcopy":
		case "worktree":
			return IsoBackendKind.Rcopy;
	}
}

export interface IsolationHandle {
	/** Merged view materialised by the backend; pass this to the task. */
	mergedDir: string;
	/** Backend the PAL actually used. */
	backend: IsoBackendKind;
	/** True when the resolver downgraded from `preferred` to `backend`. */
	fellBack: boolean;
	/** Optional reason associated with `fellBack`. */
	fallbackReason: string | null;
	/** Repo-root-relative paths inherited from the parent checkout at spawn. */
	linkedArtifacts?: readonly string[];
}

/**
 * Materialise `merged` for a single task. `preferred` is a hint — when
 * its prerequisites are missing the PAL silently falls back, and the
 * caller learns about that through `IsolationHandle.fellBack` +
 * `fallbackReason`.
 */

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * fs-safe segment naming a per-task workspace dir: prefix + 9 hex chars of
 * `Bun.hash(repoRoot\0id)`. Scratch dirs no longer reuse this name — a scratch
 * dir must be unique per RUN, and `(repoRoot, id)` is shared by every run of
 * an agent with the same name — but scratch still computes this segment and
 * records it in its `owner.json` `worktree` field for correlation.
 */
export function getTaskIsolationSegment(repoRoot: string, id: string): string {
	const key = `${path.resolve(repoRoot)}\0${id}`;
	const digest = Bun.hash(key).toString(16).padStart(16, "0").slice(-TASK_ISOLATION_DIR_DIGEST_CHARS);
	return `${TASK_ISOLATION_DIR_PREFIX}${digest}`;
}

export interface EnsureIsolationOptions {
	linkBuildArtifacts?: BuildArtifactLinkMode;
}

export async function ensureIsolation(
	baseCwd: string,
	id: string,
	preferred?: IsoBackendKind,
	options?: EnsureIsolationOptions,
): Promise<IsolationHandle> {
	const repoRoot = await getRepoRoot(baseCwd);
	const repository = await git.repo.resolve(repoRoot);
	const sourceCommonDir = repository?.commonDir ?? path.join(repoRoot, ".git");
	const baseDir = getWorktreeDir(getTaskIsolationSegment(repoRoot, id));
	const mergedDir = path.join(baseDir, TASK_ISOLATION_MOUNT_DIR);
	const resolution = natives.isoResolve(preferred ?? null);
	const candidates = resolution.candidates.length > 0 ? resolution.candidates : [resolution.kind];
	let fallbackReason = resolution.reason ?? null;

	for (const candidate of candidates) {
		await fs.rm(baseDir, { recursive: true, force: true });
		try {
			await natives.isoStart(candidate, repoRoot, mergedDir);
			// Sever the isolation's git metadata from the source checkout. Copy
			// backends duplicate `repoRoot`'s `.git` verbatim — a linked-worktree
			// pointer file (or the rcopy `git worktree add` registration) leaves
			// the isolation sharing the source's HEAD/index/ref namespace, so a
			// task's git operations would mutate the parent checkout and stack
			// parallel task branches. Detaching gives each isolation a private,
			// frozen repo that still borrows the source object DB via alternates.
			await git.detachGitDir(mergedDir, sourceCommonDir);
			const linkMode = options?.linkBuildArtifacts ?? "readonly";
			const { linked: linkedArtifacts, warnings: linkWarnings } = await linkParentBuildArtifacts(
				repoRoot,
				mergedDir,
				linkMode,
			);
			for (const warning of linkWarnings) {
				logger.warn("isolation build-artifact link skipped path", { baseDir, warning });
			}
			// Mark ownership so the GC can distinguish a live task's
			// isolation from a crashed process's leftover. Best-effort: a
			// failed write must never break task spawn.
			try {
				await fs.writeFile(
					path.join(baseDir, TASK_ISOLATION_OWNER_FILE),
					JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), repoRoot, taskId: id }),
				);
			} catch (err) {
				logger.warn("task-isolation owner marker write failed", {
					baseDir,
					error: errorMessage(err),
				});
			}
			sweepOrphanedWorkspacesOnce();
			return {
				mergedDir,
				backend: candidate,
				fellBack: candidate !== resolution.kind || resolution.fellBack,
				fallbackReason,
				linkedArtifacts: linkedArtifacts.length > 0 ? linkedArtifacts : undefined,
			};
		} catch (err) {
			await fs.rm(baseDir, { recursive: true, force: true });
			const message = errorMessage(err);
			if (!natives.isoIsUnavailableError(message)) {
				throw err;
			}
			fallbackReason ??= message;
		}
	}

	throw new Error(fallbackReason ?? "No isolation backend is available.");
}

/** Tear down a handle returned by {@link ensureIsolation}. */
export async function cleanupIsolation(handle: IsolationHandle): Promise<void> {
	try {
		try {
			await natives.isoStop(handle.backend, handle.mergedDir);
		} catch (err) {
			logger.warn("isolation backend stop failed during cleanup", {
				backend: handle.backend,
				mergedDir: handle.mergedDir,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	} finally {
		// baseDir is the parent of the merged directory
		const baseDir = path.dirname(handle.mergedDir);
		await fs.rm(baseDir, { recursive: true, force: true });
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Branch-mode isolation
// ═══════════════════════════════════════════════════════════════════════════

export interface CommitToBranchResult {
	branchName?: string;
	nestedPatches: NestedRepoPatch[];
	/**
	 * SHA of the parent-repo commit the task branch was created on top of, so
	 * {@link mergeTaskBranches} can cherry-pick the range `baseSha..branchName`
	 * and preserve every agent commit's message and author.
	 */
	baseSha?: string;
}

function baselineHasRootWip(baseline: RepoBaseline): boolean {
	return !!(baseline.staged.trim() || baseline.unstaged.trim() || baseline.untrackedPatch.trim());
}

/**
 * Baseline WIP context needed to safely apply a delta patch whose hunks were
 * captured against `HEAD + WIP` (see {@link captureRepoDeltaPatch}). Passed
 * whenever {@link baselineHasRootWip} is true so
 * {@link commitPatchToBranchWorktree} can replay the WIP into the temp
 * worktree first, then rewind WIP-only files after applying the delta.
 */
interface BaselineWipContext {
	readonly staged: string;
	readonly unstaged: string;
	readonly untrackedPatch: string;
	/** Untracked file paths present in the baseline (never in HEAD). */
	readonly untracked: readonly string[];
}

function collectWipPatches(wip: BaselineWipContext | undefined): string[] {
	if (!wip) return [];
	return [wip.staged, wip.unstaged, wip.untrackedPatch].filter(p => p.trim());
}

async function commitPatchToBranchWorktree(
	tmpDir: string,
	taskId: string,
	patchText: string,
	message: string,
	author?: git.CommitAuthor,
	baselineWip?: BaselineWipContext,
): Promise<void> {
	// Try the two clean paths first — they yield an agent-only commit and are
	// the happy case when the temp worktree can resolve the patch against
	// HEAD directly:
	//
	//   1. Plain apply — works when WIP context happens to match HEAD (e.g.
	//      WIP-touched files that the delta patch doesn't reference).
	//   2. `--3way`   — works when the WIP-side blob is tracked in HEAD and
	//      lives in the shared ODB (captureDeltaPatch seeded it while writing
	//      the synthetic baseline tree). The 3-way merge subtracts WIP,
	//      producing an agent-only commit even when WIP and agent modify the
	//      same tracked file at unrelated lines.
	//
	// If both fail (untracked WIP files, staged-new WIP files, or overlap that
	// --3way can't resolve — see #4136), replay the WIP into the worktree
	// first so the delta's context lines match, then rewind WIP-only files so
	// they don't leak into the commit. Files touched by BOTH WIP and delta
	// keep their combined state; the parent's stash-pop reconciles the WIP
	// side via 3-way merge on merge-back.
	let plainErr: git.GitCommandError | undefined;
	try {
		await git.patch.applyText(tmpDir, patchText);
	} catch (err) {
		if (!(err instanceof git.GitCommandError)) throw err;
		plainErr = err;
	}
	if (plainErr) {
		let threeWayErr: git.GitCommandError | undefined;
		try {
			await git.patch.applyText(tmpDir, patchText, { threeWay: true });
		} catch (err) {
			if (!(err instanceof git.GitCommandError)) throw err;
			threeWayErr = err;
		}
		if (threeWayErr) {
			const wipPatches = collectWipPatches(baselineWip);
			if (wipPatches.length === 0 || !baselineWip) {
				const stderr = threeWayErr.result.stderr.slice(0, 2000);
				logger.error("commitToBranch: git apply --3way failed", {
					taskId,
					exitCode: threeWayErr.result.exitCode,
					stderr,
					initialStderr: plainErr.result.stderr.slice(0, 2000),
					patchSize: patchText.length,
					patchHead: patchText.slice(0, 500),
				});
				throw new Error(`git apply --3way failed for task ${taskId}: ${stderr}`);
			}
			try {
				// `git apply --3way` leaves conflict markers in `U` files when
				// it can't resolve; reset the worktree so the WIP-seeded retry
				// starts from a clean HEAD tree.
				await git.reset(tmpDir, { hard: true, target: "HEAD" });
				await applyDeltaOverBaselineWip(tmpDir, taskId, patchText, wipPatches, baselineWip);
			} catch (wipErr) {
				if (!(wipErr instanceof git.GitCommandError)) throw wipErr;
				const stderr = wipErr.result.stderr.slice(0, 2000);
				logger.error("commitToBranch: git apply with baseline WIP failed", {
					taskId,
					exitCode: wipErr.result.exitCode,
					stderr,
					threeWayStderr: threeWayErr.result.stderr.slice(0, 2000),
					initialStderr: plainErr.result.stderr.slice(0, 2000),
					patchSize: patchText.length,
					patchHead: patchText.slice(0, 500),
				});
				throw new Error(`git apply with baseline WIP failed for task ${taskId}: ${stderr}`);
			}
		}
	}

	await git.stage.files(tmpDir);
	await git.commit(tmpDir, message, author ? { author } : {});
}

/**
 * Replay baseline WIP into the temp worktree so the delta patch's HEAD+WIP
 * context matches, apply the delta, then rewind files WIP touched but the
 * delta didn't — HEAD-tracked files are restored via `git restore`, untracked
 * or staged-new WIP files are removed from the worktree. The commit that
 * follows reflects agent's delta plus any overlap with WIP; parent's
 * stash-pop reconciles the WIP side on merge-back.
 */
async function applyDeltaOverBaselineWip(
	tmpDir: string,
	_taskId: string,
	patchText: string,
	wipPatches: readonly string[],
	baselineWip: BaselineWipContext,
): Promise<void> {
	for (const wip of wipPatches) {
		await git.patch.applyText(tmpDir, wip);
	}
	await git.patch.applyText(tmpDir, patchText);

	const wipFiles = new Set(wipPatches.flatMap(patchTouchedFiles));
	const deltaFiles = new Set(patchTouchedFiles(patchText));
	const wipOnly = [...wipFiles].filter(f => !deltaFiles.has(f));
	if (wipOnly.length === 0) return;

	// Any wipOnly file baselined as untracked cannot be in HEAD.
	// Everything else may or may not — verify against HEAD's tree.
	const untrackedSet = new Set(baselineWip.untracked);
	const candidates = wipOnly.filter(f => !untrackedSet.has(f));
	const inHead = candidates.length > 0 ? new Set(await git.ls.tree(tmpDir, "HEAD", candidates)) : new Set<string>();
	const toRestore = candidates.filter(f => inHead.has(f));
	const toRemove = wipOnly.filter(f => !toRestore.includes(f));
	if (toRestore.length > 0) {
		await git.restore(tmpDir, { source: "HEAD", staged: true, worktree: true, files: toRestore });
	}
	for (const rel of toRemove) {
		await fs.rm(path.join(tmpDir, rel), { force: true });
	}
}

interface FilteredAgentReplayOptions {
	baseline: WorktreeBaseline;
	branchName: string;
	commitMessage?: (diff: string) => Promise<string | null>;
	fallbackMessage: string;
	isolationDir: string;
	isolationHead: string;
	repoRoot: string;
	rootPatch: string;
	taskId: string;
}

async function replayFilteredAgentCommits(opts: FilteredAgentReplayOptions): Promise<void> {
	const baselineSha = opts.baseline.root.headCommit;
	await git.branch.create(opts.repoRoot, opts.branchName, baselineSha);

	const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
	try {
		await git.worktree.add(opts.repoRoot, tmpDir, opts.branchName);
		const agentCommits = await git.revList.range(opts.isolationDir, baselineSha, opts.isolationHead);
		const dirtyBaselineTree = await writeSyntheticTree(opts.isolationDir, baselineSha, [
			opts.baseline.root.staged,
			opts.baseline.root.unstaged,
			opts.baseline.root.untrackedPatch,
		]);
		let previousFilteredTree = baselineSha;
		let filteredCommitsApplied = 0;

		for (const commitSha of agentCommits) {
			const taskStatePatch = await git.diff.tree(opts.isolationDir, dirtyBaselineTree, `${commitSha}^{tree}`, {
				allowFailure: true,
				binary: true,
			});
			const currentFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [taskStatePatch]);
			const commitPatch = await git.diff.tree(opts.repoRoot, previousFilteredTree, currentFilteredTree, {
				allowFailure: true,
				binary: true,
			});
			if (commitPatch.trim()) {
				const details = await git.commitDetails(opts.isolationDir, commitSha);
				await commitPatchToBranchWorktree(
					tmpDir,
					opts.taskId,
					commitPatch,
					details.message || commitSha,
					details.author,
				);
				filteredCommitsApplied++;
			}
			previousFilteredTree = currentFilteredTree;
		}
		if (filteredCommitsApplied === 0) {
			// No filtered commit landed — tmpDir is still pinned at baselineSha.
			// The `finalFilteredTree = writeSyntheticTree(HEAD, [rootPatch])`
			// path here fails hard whenever rootPatch's WIP-context can't be
			// applied to a HEAD-only index (untracked WIP + agent modifies,
			// staged-new WIP + agent modifies — see #4136). Bypass the synthesis
			// entirely and collapse the isolation output onto a single commit
			// with WIP seed, matching the no-agent-commit path in commitToBranch.
			// This also handles the "agent committed only baseline WIP" corner
			// case where every filtered patch collapsed to empty.
			if (opts.rootPatch.trim()) {
				const msg = (opts.commitMessage && (await opts.commitMessage(opts.rootPatch))) || opts.fallbackMessage;
				await commitPatchToBranchWorktree(tmpDir, opts.taskId, opts.rootPatch, msg, undefined, opts.baseline.root);
			}
		} else {
			// A filtered commit landed; tmpDir has advanced past baselineSha and
			// previousFilteredTree is HEAD-derived, so writeSyntheticTree +
			// leftoverPatch stay HEAD-based and no WIP seed is needed.
			const finalFilteredTree = await writeSyntheticTree(opts.repoRoot, baselineSha, [opts.rootPatch]);
			const leftoverPatch = await git.diff.tree(opts.repoRoot, previousFilteredTree, finalFilteredTree, {
				allowFailure: true,
				binary: true,
			});
			if (leftoverPatch.trim()) {
				const msg = (opts.commitMessage && (await opts.commitMessage(leftoverPatch))) || opts.fallbackMessage;
				await commitPatchToBranchWorktree(tmpDir, opts.taskId, leftoverPatch, msg);
			}
		}
	} finally {
		await git.worktree.tryRemove(opts.repoRoot, tmpDir);
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

/**
 * Capture task-only changes from the isolation worktree onto a parent-repo
 * branch named `omp/task/${taskId}`. Only root-repo changes go on the branch;
 * nested-repo patches are returned separately because the parent git can't
 * track files inside gitlinks.
 *
 * If the agent committed inside isolation (HEAD moved past
 * `baseline.root.headCommit`), clean-baseline runs fetch the raw commit range
 * into the parent repo and later cherry-pick `baseSha..branchName`, preserving
 * every message and author verbatim. Dirty-baseline runs rewrite each agent
 * commit against the captured baseline WIP before committing it to the task
 * branch, so user staged/unstaged/untracked changes present at isolation
 * start are not replayed into the parent commit history.
 *
 * If the agent did not commit, the captured delta is collapsed onto a single
 * branch commit with an AI-generated (or fallback) message — the legacy
 * behaviour.
 *
 * Returns `null` when no root or nested changes exist.
 */
export async function commitToBranch(
	isolationDir: string,
	baseline: WorktreeBaseline,
	taskId: string,
	description: string | undefined,
	commitMessage?: (diff: string) => Promise<string | null>,
): Promise<CommitToBranchResult | null> {
	const baselineSha = baseline.root.headCommit;
	const isolationHead = (await git.head.sha(isolationDir)) ?? "";
	const agentCommitted = isolationHead !== "" && isolationHead !== baselineSha;

	const { rootPatch, nestedPatches } = await captureDeltaPatch(isolationDir, baseline);
	if (!rootPatch.trim() && nestedPatches.length === 0) return null;
	if (!rootPatch.trim()) return { nestedPatches };

	const repoRoot = baseline.root.repoRoot;
	const branchName = `omp/task/${taskId}`;
	const fallbackMessage = description || taskId;

	let branchCreated = false;

	if (agentCommitted) {
		if (baselineHasRootWip(baseline.root)) {
			await replayFilteredAgentCommits({
				baseline,
				branchName,
				commitMessage,
				fallbackMessage,
				isolationDir,
				isolationHead,
				repoRoot,
				rootPatch,
				taskId,
			});
		} else {
			// Transfer the agent's commit objects (which live in isolation's `.git`,
			// stranded once `cleanupIsolation` tears the overlay down) into the parent
			// repo's object DB and create the branch at the agent's HEAD. `+HEAD:…`
			// force-overwrites a stale branch from a prior run.
			await git.fetch(repoRoot, isolationDir, "HEAD", `refs/heads/${branchName}`);

			// Leftover = anything still uncommitted in isolation on top of the
			// agent's last commit (staged, unstaged, untracked). The agent didn't
			// commit it, so it goes in as one AI-summarized trailing commit.
			const leftoverPatch = await captureRepoDeltaPatch(isolationDir, {
				repoRoot: isolationDir,
				headCommit: isolationHead,
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			});
			if (leftoverPatch.trim()) {
				const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
				try {
					await git.worktree.add(repoRoot, tmpDir, branchName);
					const msg = (commitMessage && (await commitMessage(leftoverPatch))) || fallbackMessage;
					await commitPatchToBranchWorktree(tmpDir, taskId, leftoverPatch, msg);
				} finally {
					await git.worktree.tryRemove(repoRoot, tmpDir);
					await fs.rm(tmpDir, { recursive: true, force: true });
				}
			}
		}
		branchCreated = true;
	} else if (rootPatch.trim()) {
		await git.branch.create(repoRoot, branchName, baselineSha);
		branchCreated = true;
		const tmpDir = path.join(os.tmpdir(), `omp-branch-${Snowflake.next()}`);
		try {
			await git.worktree.add(repoRoot, tmpDir, branchName);

			const msg = (commitMessage && (await commitMessage(rootPatch))) || fallbackMessage;
			const wip = baselineHasRootWip(baseline.root) ? baseline.root : undefined;
			await commitPatchToBranchWorktree(tmpDir, taskId, rootPatch, msg, undefined, wip);
		} finally {
			await git.worktree.tryRemove(repoRoot, tmpDir);
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	}

	return {
		branchName: branchCreated ? branchName : undefined,
		baseSha: baselineSha,
		nestedPatches,
	};
}

export interface MergeBranchResult {
	merged: string[];
	failed: string[];
	conflict?: string;
	/** Set when cherry-picks landed on HEAD but restoring the stashed working tree failed. */
	stashConflict?: string;
}

/**
 * Cherry-pick task branch commits sequentially onto HEAD. When `baseSha` is
 * provided the cherry-pick uses the inclusive range `baseSha..branchName`,
 * replaying every commit individually and preserving each commit's message
 * and author. When omitted, the branch is cherry-picked as a single commit
 * (legacy callers).
 *
 * Stops on the first conflict and reports which branches succeeded.
 */
export async function mergeTaskBranches(
	repoRoot: string,
	branches: Array<{ branchName: string; taskId: string; description?: string; baseSha?: string }>,
): Promise<MergeBranchResult> {
	// Serialize against other in-process git mutations on this repo: concurrent
	// background merges interleaving stash push/pop + cherry-pick would corrupt
	// the working tree (lost uncommitted changes, mixed-up stash entries).
	return git.withRepoLock(repoRoot, async () => {
		const merged: string[] = [];
		const failed: string[] = [];

		// Stash dirty working tree so cherry-pick can operate on a clean HEAD.
		// Without this, cherry-pick refuses to run when uncommitted changes exist.
		const didStash = await git.stash.push(repoRoot, "omp-task-merge");

		let conflictResult: MergeBranchResult | undefined;

		try {
			for (const { branchName, baseSha } of branches) {
				try {
					const target = baseSha ? `${baseSha}..${branchName}` : branchName;
					await git.cherryPick(repoRoot, target);
				} catch (initialErr) {
					// Empty cherry-picks are not conflicts: a commit whose net
					// effect is already on HEAD (redundant change, or 3-way
					// merge auto-resolved to HEAD) leaves the sequencer stopped
					// with a "The previous cherry-pick is now empty" message.
					// Advance past every consecutive empty with `--skip` so the
					// remaining non-redundant commits in the range still land.
					// A genuine conflict (unmerged files, no "now empty"
					// message) falls through to the abort path below.
					let cursor: unknown = initialErr;
					while (git.cherryPick.isEmptyError(cursor)) {
						try {
							await git.cherryPick.skip(repoRoot);
							cursor = undefined;
							break;
						} catch (skipErr) {
							cursor = skipErr;
						}
					}
					if (cursor === undefined) {
						merged.push(branchName);
						continue;
					}
					try {
						await git.cherryPick.abort(repoRoot);
					} catch {
						/* no state to abort */
					}
					const stderr =
						cursor instanceof git.GitCommandError
							? cursor.result.stderr.trim()
							: cursor instanceof Error
								? cursor.message
								: String(cursor);
					failed.push(branchName);
					conflictResult = {
						merged,
						failed: [...failed, ...branches.slice(merged.length + failed.length).map(b => b.branchName)],
						conflict: `${branchName}: ${stderr}`,
					};
					break;
				}

				merged.push(branchName);
			}
		} finally {
			if (didStash) {
				const restored = await git.stash.tryPop(repoRoot, { index: true });
				if (!restored) {
					// Stash pop would leave stage 1/2/3 unmerged entries in `.git/index`
					// that overlay-isolated subsequent tasks inherit through the lower
					// layer, corrupting every downstream `captureRepoDeltaPatch`. `tryPop`
					// short-circuits the pop when the WIP would conflict with the
					// cherry-picked HEAD (and reset-cleans up if a rarer conflict slips
					// past). The merged branches DID land — surface a stash-restore
					// warning without claiming the merge failed.
					logger.warn("Failed to restore stashed changes after task merge; stash entry preserved");
					const stashConflict =
						"stash pop: cherry-picked changes conflict with uncommitted edits. The merged commits are on HEAD; run `git stash pop` and resolve manually.";
					if (conflictResult) {
						conflictResult.stashConflict = stashConflict;
					} else {
						conflictResult = { merged, failed: [], stashConflict };
					}
				}
			}
		}

		return conflictResult ?? { merged, failed };
	});
}

/** Clean up temporary task branches. */
export async function cleanupTaskBranches(repoRoot: string, branches: string[]): Promise<void> {
	for (const branch of branches) {
		await git.branch.tryDelete(repoRoot, branch);
	}
}
