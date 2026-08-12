import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { reconcileRepoMemoryTree } from "../src/commands/sync-context";

describe("sync-context repo memory-tree reconcile", () => {
	it("renders a touched repo's bank into its tree", async () => {
		const root = await TempDir.create("@sync-context-reconcile-");
		try {
			const dbDir = path.join(root.path(), "mnemopi");
			const bank = "llvm-x86-agent-chat";
			const dbPath = path.join(dbDir, "banks", bank, "mnemopi.db");

			const memory = new Mnemopi({ dbPath, bank, sessionId: "sync-context-test", noEmbeddings: true });
			memory.remember("The SSE push layer ships change events over EventSource.", {
				source: "test",
				importance: 0.8,
				veracity: "user",
				memoryType: "fact",
				metadata: { subtree: "projects/agent-chat" },
				scope: "bank",
			});
			memory.close();

			const treeRoot = path.join(root.path(), "tree");
			const rendered = await reconcileRepoMemoryTree(treeRoot, dbDir, bank);
			expect(rendered).toBe(true);

			const subtreeDir = path.join(treeRoot, "projects", "agent-chat");
			expect(existsSync(path.join(treeRoot, "MEMORY.md"))).toBe(true);
			expect(existsSync(path.join(subtreeDir, "MEMORY.md"))).toBe(true);
			const leafNames = (await readdir(subtreeDir)).filter(name => name !== "MEMORY.md");
			expect(leafNames.length).toBe(1);
			const leaf = readFileSync(path.join(subtreeDir, leafNames[0]), "utf8");
			expect(leaf).toContain("status: active");
			expect(leaf).toContain("EventSource");
		} finally {
			await root.remove();
		}
	});

	it("skips repos with no bank (cwd-derived lanes)", async () => {
		const root = await TempDir.create("@sync-context-reconcile-");
		try {
			const rendered = await reconcileRepoMemoryTree(
				path.join(root.path(), "tree"),
				path.join(root.path(), "mnemopi"),
				"never-opened-repo",
			);
			expect(rendered).toBe(false);
		} finally {
			await root.remove();
		}
	});
});
