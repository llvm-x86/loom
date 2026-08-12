import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

			const bankRoot = path.join(treeRoot, bank);
			const subtreeDir = path.join(bankRoot, "projects", "agent-chat");
			expect(existsSync(path.join(bankRoot, "MEMORY.md"))).toBe(true);
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

	it("skips non-slug repos (path traversal / junk never render)", async () => {
		const root = await TempDir.create("@sync-context-reconcile-");
		try {
			const dbDir = path.join(root.path(), "mnemopi");
			const bank = "llvm-x86-agent-chat";
			const dbPath = path.join(dbDir, "banks", bank, "mnemopi.db");
			const memory = new Mnemopi({ dbPath, bank, sessionId: "reject-test", noEmbeddings: true });
			memory.remember("row that must never render", { source: "test", scope: "bank" });
			memory.close();

			const treeRoot = path.join(root.path(), "tree");
			for (const junk of ["../..", "..", ".", "a/b", "a.b", "with space", "a".repeat(200)]) {
				expect(await reconcileRepoMemoryTree(treeRoot, dbDir, junk)).toBe(false);
			}
			expect(await reconcileRepoMemoryTree(treeRoot, dbDir, bank)).toBe(true);
			expect(existsSync(path.join(treeRoot, bank, "MEMORY.md"))).toBe(true);
			// The junk slugs must not have escaped the tree root or written files.
			const direct = readdirSync(path.join(treeRoot));
			expect(direct.filter(name => name !== bank).length).toBe(0);
		} finally {
			await root.remove();
		}
	});
});
