/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectAgentDir, isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { getActiveSkills, type Skill } from "../extensibility/skills";
import { buildDirectoryResource } from "./filesystem-resource";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	return "text/plain";
}

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}

/**
 * Best-effort load of a single skill that was written to disk after the
 * session started (e.g. the loom-webbridge skill installed by the daemon).
 * Returns undefined if the skill file does not exist or is invalid.
 */
async function loadSkillFromDisk(skillName: string, cwd?: string): Promise<Skill | undefined> {
	const candidates = [path.join(getAgentDir(), "skills", skillName, "SKILL.md")];
	if (cwd) {
		candidates.push(path.join(getProjectAgentDir(cwd), "skills", skillName, "SKILL.md"));
	}

	for (const skillPath of candidates) {
		let content: string;
		try {
			content = await Bun.file(skillPath).text();
		} catch (error) {
			if (isEnoent(error)) continue;
			return undefined;
		}

		try {
			const { frontmatter } = parseFrontmatter(content, { source: skillPath });
			if (frontmatter.enabled === false) continue;
			const baseDir = skillPath.replace(/[\\/]SKILL\.md$/, "");
			return {
				name: typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : skillName,
				description: typeof frontmatter.description === "string" ? frontmatter.description : "",
				filePath: skillPath,
				baseDir,
				source: "ondemand-skill-load",
				hide: frontmatter.hide === true || frontmatter.disableModelInvocation === true,
			};
		} catch {
			return undefined;
		}
	}

	return undefined;
}

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const skills = context?.skills ?? getActiveSkills();

		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			throw new Error("skill:// URL requires a skill name: skill://<name>");
		}

		let skill = skills.find(s => s.name === skillName);
		if (!skill) {
			// Skills written after session start (e.g. loom-webbridge) may not be
			// in the process-global snapshot. Try to load directly from disk.
			skill = await loadSkillFromDisk(skillName, context?.cwd);
		}
		if (!skill) {
			const available = skills.map(s => s.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
		}

		let targetPath: string;
		const urlPath = url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		if (hasRelativePath) {
			const relativePath = decodeURIComponent(urlPath.slice(1));
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);

			const resolvedPath = path.resolve(targetPath);
			const resolvedBaseDir = path.resolve(skill.baseDir);
			if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
				throw new Error("Path traversal is not allowed");
			}
		} else {
			targetPath = context?.pathOnly === true ? skill.baseDir : skill.filePath;
		}

		let stats: fsTypes.Stats;
		try {
			stats = await fs.stat(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`File not found: ${targetPath}`);
			}
			throw error;
		}

		if (stats.isDirectory()) {
			return buildDirectoryResource(url.href, targetPath);
		}
		if (!stats.isFile()) {
			throw new Error(`skill:// URL must resolve to a file or directory: ${url.href}`);
		}

		const content = await Bun.file(targetPath).text();
		return {
			url: url.href,
			content,
			contentType: getContentType(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveSkills().map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
