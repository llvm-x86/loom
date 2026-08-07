import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * How an isolated worktree inherits gitignored build outputs from the parent
 * checkout. `readonly` copies only small generated binaries (safe default).
 * `full` additionally symlinks `node_modules` and `target` per the manual
 * worktree recipe — opt-in only; shared stores let one subagent mutate the
 * parent's deps.
 */
export type BuildArtifactLinkMode = "off" | "readonly" | "full";

export const TOOL_VIEWS_RELATIVE = "packages/coding-agent/src/export/html/tool-views.generated.js";
export const NATIVES_RELATIVE_DIR = "packages/natives/native";

export interface LinkBuildArtifactsResult {
	/** Repo-root-relative paths linked or copied into the isolation worktree. */
	linked: string[];
	warnings: string[];
}

export async function linkParentBuildArtifacts(
	repoRoot: string,
	mergedDir: string,
	mode: BuildArtifactLinkMode,
): Promise<LinkBuildArtifactsResult> {
	if (mode === "off") {
		return { linked: [], warnings: [] };
	}

	const linked: string[] = [];
	const warnings: string[] = [];

	await copyFileArtifact(repoRoot, mergedDir, TOOL_VIEWS_RELATIVE, linked, warnings);

	if (mode === "readonly") {
		await copyNativeAddons(repoRoot, mergedDir, linked, warnings);
	} else {
		await linkDirectory(repoRoot, mergedDir, "node_modules", linked, warnings);
		await linkDirectory(repoRoot, mergedDir, "target", linked, warnings);
		await linkNativeAddonSymlinks(repoRoot, mergedDir, linked, warnings);
	}

	return { linked, warnings };
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

async function copyNativeAddons(
	repoRoot: string,
	mergedDir: string,
	linked: string[],
	warnings: string[],
): Promise<void> {
	const nativesDir = path.join(repoRoot, NATIVES_RELATIVE_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(nativesDir);
	} catch {
		return;
	}

	for (const name of entries) {
		if (!name.endsWith(".node")) continue;
		const relativePath = path.posix.join(NATIVES_RELATIVE_DIR, name);
		await copyFileArtifact(repoRoot, mergedDir, relativePath, linked, warnings);
	}
}

async function linkDirectory(
	repoRoot: string,
	mergedDir: string,
	relativeDir: string,
	linked: string[],
	warnings: string[],
): Promise<void> {
	const source = path.join(repoRoot, relativeDir);
	if (!(await pathExists(source))) return;

	const destination = path.join(mergedDir, relativeDir);
	if (await pathExists(destination)) return;

	try {
		await fs.symlink(source, destination);
		linked.push(`${relativeDir}/`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warnings.push(`${relativeDir}/: ${message}`);
		logger.warn("isolation build-artifact symlink failed", { relativeDir, error: message });
	}
}

async function linkNativeAddonSymlinks(
	repoRoot: string,
	mergedDir: string,
	linked: string[],
	warnings: string[],
): Promise<void> {
	const nativesDir = path.join(repoRoot, NATIVES_RELATIVE_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(nativesDir);
	} catch {
		return;
	}

	const destinationDir = path.join(mergedDir, NATIVES_RELATIVE_DIR);
	await fs.mkdir(destinationDir, { recursive: true });

	for (const name of entries) {
		if (!name.endsWith(".node")) continue;
		const relativePath = path.posix.join(NATIVES_RELATIVE_DIR, name);
		const source = path.join(repoRoot, relativePath);
		const destination = path.join(mergedDir, relativePath);
		if (await pathExists(destination)) continue;
		try {
			await fs.symlink(source, destination);
			linked.push(relativePath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			warnings.push(`${relativePath}: ${message}`);
			logger.warn("isolation native addon symlink failed", { relativePath, error: message });
		}
	}
}
