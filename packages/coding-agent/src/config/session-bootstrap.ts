/**
 * Session bootstrap: injects the contents of user-configured files into every
 * session's system prompt at start (environment briefings, project ledgers).
 *
 * Total no-op when `sessionBootstrap` is unset/empty: {@link loadSessionBootstrapBlock}
 * returns `null` without touching the filesystem.
 */

import * as fs from "node:fs/promises";
import { expandTilde } from "../tools/path-utils";

/**
 * Read each configured path (tilde-expanded), skipping missing/unreadable
 * files with a stderr warning (never fatal), and compose them into a single
 * appendable system-prompt block. Returns `null` when `paths` is empty or
 * every path failed to read.
 */
export async function loadSessionBootstrapBlock(paths: string[]): Promise<string | null> {
	if (paths.length === 0) return null;

	const files: Array<{ path: string; content: string }> = [];
	for (const rawPath of paths) {
		const expanded = expandTilde(rawPath);
		try {
			const content = await fs.readFile(expanded, "utf8");
			files.push({ path: rawPath, content });
		} catch (err) {
			console.error(`[sessionBootstrap] skipped ${rawPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (files.length === 0) return null;

	const fileBlocks = files.map(({ path: p, content }) => `<file path="${p}">\n${content}\n</file>`).join("\n\n");
	return `## Session bootstrap context\n\n${fileBlocks}`;
}
