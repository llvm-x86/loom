import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * How an isolated worktree inherits gitignored build outputs from the parent
 * checkout. `readonly` copies only small generated files (safe default).
 * `full` additionally symlinks the dependency/build stores of whichever
 * ecosystems the repo actually uses — opt-in only; shared stores let one
 * subagent mutate the parent's deps.
 */
export type BuildArtifactLinkMode = "off" | "readonly" | "full";

export const TOOL_VIEWS_RELATIVE = "packages/coding-agent/src/export/html/tool-views.generated.js";
export const NATIVES_RELATIVE_DIR = "packages/natives/native";

/**
 * One ecosystem's inheritable artifacts. Every row is gated on a marker file,
 * which is what makes the table safe to grow: the Ruby row cannot touch a Go
 * checkout, and a repo matching nothing is left exactly as git left it.
 */
export interface BuildArtifactRule {
	/** Repo-root-relative marker paths; the rule activates when any one exists. */
	markers: readonly string[];
	/** Dependency/build stores, symlinked in `full` only — far too large to copy per spawn. */
	dirs?: readonly string[];
	/** Small generated files, copied in both `readonly` and `full`. */
	files?: readonly string[];
	/** Directories whose immediate `suffix` children are copied in `readonly`, symlinked in `full`. */
	suffixDirs?: readonly { dir: string; suffix: string }[];
}

export const BUILD_ARTIFACT_RULES: readonly BuildArtifactRule[] = [
	{ markers: ["package.json"], dirs: ["node_modules"] },
	{ markers: ["Cargo.toml"], dirs: ["target"] },
	{ markers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"], dirs: ["venv", ".venv"] },
	{ markers: ["go.mod"], dirs: ["vendor"] },
	{ markers: ["Gemfile"], dirs: [".bundle", "vendor/bundle"] },
	{ markers: ["composer.json"], dirs: ["vendor"] },
	{ markers: ["build.gradle", "build.gradle.kts", "pom.xml"], dirs: [".gradle"] },
	// loom's own outputs are an ordinary row, not a special case: generated JS
	// the HTML exporter imports, plus whatever addons the natives build left.
	{
		markers: ["packages/coding-agent/package.json"],
		files: [TOOL_VIEWS_RELATIVE],
		suffixDirs: [{ dir: NATIVES_RELATIVE_DIR, suffix: ".node" }],
	},
];

export interface LinkBuildArtifactsResult {
	/** Repo-root-relative paths linked or copied into the isolation worktree. */
	linked: string[];
	warnings: string[];
}

export async function linkParentBuildArtifacts(
	repoRoot: string,
	mergedDir: string,
	mode: BuildArtifactLinkMode,
	extraPaths: readonly string[] = [],
): Promise<LinkBuildArtifactsResult> {
	const linked: string[] = [];
	const warnings: string[] = [];

	// The configured allowlist is orthogonal to `mode`: `mode` governs what the
	// ecosystem table infers, `extraPaths` is what the operator named for this
	// repo. "off" disables the former, never the latter — a project whose store
	// no marker predicts is precisely mode "off" plus `["venv", ".env"]`.
	await linkConfiguredPaths(repoRoot, mergedDir, extraPaths, linked, warnings);

	if (mode === "off") {
		return { linked, warnings };
	}

	// One attempt per distinct path: two active rules can name the same store
	// (`go.mod` and `composer.json` both want `vendor`), and the allowlist may
	// have seeded it already — a second attempt would only warn about a
	// destination that is by then correctly populated.
	const claimed = new Set(linked.map(entry => entry.replace(/\/$/, "")));
	const claim = (relative: string): boolean => {
		if (claimed.has(relative)) return false;
		claimed.add(relative);
		return true;
	};

	for (const rule of await activeRules(repoRoot)) {
		for (const relativePath of rule.files ?? []) {
			if (claim(relativePath)) await copyFileArtifact(repoRoot, mergedDir, relativePath, linked, warnings);
		}
		for (const { dir, suffix } of rule.suffixDirs ?? []) {
			await linkSuffixedEntries(repoRoot, mergedDir, dir, suffix, mode, claim, linked, warnings);
		}
		if (mode !== "full") continue;
		for (const relativeDir of rule.dirs ?? []) {
			if (claim(relativeDir)) await linkDirectory(repoRoot, mergedDir, relativeDir, linked, warnings);
		}
	}

	return { linked, warnings };
}

/** Rules whose ecosystem this repo actually uses, in table order. */
async function activeRules(repoRoot: string): Promise<BuildArtifactRule[]> {
	const matches = await Promise.all(
		BUILD_ARTIFACT_RULES.map(async rule => {
			for (const marker of rule.markers) {
				if (await pathExists(path.join(repoRoot, marker))) return rule;
			}
			return undefined;
		}),
	);
	return matches.filter((rule): rule is BuildArtifactRule => rule !== undefined);
}

/**
 * Seed operator-named gitignored paths into the worktree. Directories are
 * symlinked because the interesting ones (`venv/`, `node_modules/`) are far
 * too large to copy per spawn; files are copied so a subagent rewriting
 * `.env` cannot mutate the parent checkout's copy.
 */
async function linkConfiguredPaths(
	repoRoot: string,
	mergedDir: string,
	requested: readonly string[],
	linked: string[],
	warnings: string[],
): Promise<void> {
	const seen = new Set<string>();
	for (const raw of requested) {
		const candidate = raw.trim();
		if (candidate.length === 0) continue;

		const relative = normalizeRepoRelative(repoRoot, candidate);
		if (relative === undefined) {
			warnings.push(`${candidate}: outside the repository root — skipped`);
			logger.warn("isolation link path rejected", { path: candidate, reason: "escapes repo root" });
			continue;
		}
		if (seen.has(relative)) continue;
		seen.add(relative);

		const source = path.join(repoRoot, relative);
		let isDirectory: boolean;
		try {
			isDirectory = (await fs.stat(source)).isDirectory();
		} catch {
			// Absent in the parent is not an error: a config naming `venv` is
			// shared across repos that may not all have one.
			continue;
		}

		if (isDirectory) {
			await linkDirectory(repoRoot, mergedDir, relative, linked, warnings);
		} else {
			await copyFileArtifact(repoRoot, mergedDir, relative, linked, warnings);
		}
	}
}

/** Repo-root-relative form of `candidate`, or undefined when it escapes the root. */
function normalizeRepoRelative(repoRoot: string, candidate: string): string | undefined {
	const root = path.resolve(repoRoot);
	const resolved = path.resolve(root, candidate);
	if (resolved === root) return undefined;
	const relative = path.relative(root, resolved);
	if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return relative;
}

/** True when an ignored-entry path was seeded from the parent and should not surface as divergence. */
export function shouldSkipLinkedIgnoredEntry(entry: string, linked: readonly string[]): boolean {
	if (linked.length === 0) return false;
	const bare = entry.replace(/\/$/, "");
	return linked.some(skipPath => {
		const skipBare = skipPath.replace(/\/$/, "");
		return bare === skipBare || bare.startsWith(`${skipBare}/`);
	});
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch {
		return false;
	}
}

async function copyFileArtifact(
	repoRoot: string,
	mergedDir: string,
	relativePath: string,
	linked: string[],
	warnings: string[],
): Promise<void> {
	const source = path.join(repoRoot, relativePath);
	if (!(await pathExists(source))) return;

	const destination = path.join(mergedDir, relativePath);
	if (await pathExists(destination)) return;

	try {
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.copyFile(source, destination);
		linked.push(relativePath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warnings.push(`${relativePath}: ${message}`);
		logger.warn("isolation build-artifact copy failed", { relativePath, error: message });
	}
}

/**
 * Immediate children of `relativeDir` ending in `suffix`. Copied in `readonly`
 * so the worktree owns its own binaries, symlinked in `full` to match that
 * mode's shared-store bargain. Prebuilt native addons are the motivating case:
 * a handful of files next to a directory of sources that must not be inherited.
 */
async function linkSuffixedEntries(
	repoRoot: string,
	mergedDir: string,
	relativeDir: string,
	suffix: string,
	mode: BuildArtifactLinkMode,
	claim: (relative: string) => boolean,
	linked: string[],
	warnings: string[],
): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(path.join(repoRoot, relativeDir));
	} catch {
		return;
	}

	for (const name of entries) {
		if (!name.endsWith(suffix)) continue;
		const relativePath = path.posix.join(relativeDir, name);
		if (!claim(relativePath)) continue;
		if (mode === "full") {
			await symlinkArtifact(repoRoot, mergedDir, relativePath, relativePath, linked, warnings);
		} else {
			await copyFileArtifact(repoRoot, mergedDir, relativePath, linked, warnings);
		}
	}
}

async function linkDirectory(
	repoRoot: string,
	mergedDir: string,
	relativeDir: string,
	linked: string[],
	warnings: string[],
): Promise<void> {
	// The trailing slash is what lets the ignored-divergence filter match paths
	// nested under the link.
	await symlinkArtifact(repoRoot, mergedDir, relativeDir, `${relativeDir}/`, linked, warnings);
}

/**
 * Symlink `relative` from the parent checkout into the worktree, reporting it
 * as `label`.
 *
 * Skipping when the destination already exists is load-bearing, not just an
 * optimisation: it is what keeps a TRACKED path safe. A Go repo that commits
 * `vendor/` already has it in the worktree from the git checkout, so the rule
 * finds the destination occupied and can never shadow real source with a link
 * to the parent's copy.
 */
async function symlinkArtifact(
	repoRoot: string,
	mergedDir: string,
	relative: string,
	label: string,
	linked: string[],
	warnings: string[],
): Promise<void> {
	const source = path.join(repoRoot, relative);
	if (!(await pathExists(source))) return;

	const destination = path.join(mergedDir, relative);
	if (await pathExists(destination)) return;

	try {
		// Nested rule paths (`vendor/bundle`, the natives dir) have no parent in
		// a bare worktree until we make one.
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.symlink(source, destination);
		linked.push(label);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warnings.push(`${label}: ${message}`);
		logger.warn("isolation build-artifact symlink failed", { relative: label, error: message });
	}
}
