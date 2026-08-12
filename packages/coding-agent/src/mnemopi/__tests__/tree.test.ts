import { describe, expect, it } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core";
import { findMemoryIdsBySubstring, renderMemoryTree, restoreMemoryRow } from "../tree";

describe("memory tree", () => {
	function makeMemory(): Mnemopi {
		return new Mnemopi({ dbPath: ":memory:", sessionId: "tree-test", bank: "testbank" });
	}

	function makeRoot(): string {
		return mkdtempSync(path.join(tmpdir(), "loom-tree-test-"));
	}

	function cleanup(root: string): void {
		rmSync(root, { recursive: true, force: true });
	}

	it("renders leaves and entry points from remembered rows", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			const id = memory.remember("The SSE push layer ships change events over EventSource.", {
				source: "test",
				importance: 0.8,
				veracity: "user",
				memoryType: "fact",
				metadata: { subtree: "projects/agent-chat" },
				scope: "bank",
			});
			expect(id).toBeTruthy();

			const result = await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			expect(result.written).toBe(1);
			expect(result.leaves).toBe(1);

			const subtreeDir = path.join(root, "projects", "agent-chat");
			const leafPath = path.join(subtreeDir, `${id}.md`);
			const leaf = await readFile(leafPath, "utf8");
			expect(leaf).toContain("status: active");
			expect(leaf).toContain("The SSE push layer ships change events over EventSource.");

			const subtreeEntry = await readFile(path.join(subtreeDir, "MEMORY.md"), "utf8");
			expect(subtreeEntry).toContain(id);
			expect(subtreeEntry).toContain("SSE push layer");

			const rootEntry = await readFile(path.join(root, "MEMORY.md"), "utf8");
			expect(rootEntry).toContain("projects/agent-chat");
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("folds cwd metadata into projects/<basename> when no subtree is given", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			memory.remember("watched the kiosk deployment", {
				source: "test",
				metadata: { cwd: "/home/ubuntu/workspace/kiosk" },
				scope: "bank",
			});
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			const entry = await readFile(path.join(root, "projects", "kiosk", "MEMORY.md"), "utf8");
			expect(entry).toContain("watched the kiosk deployment");
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("re-renders idempotently", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			memory.remember("conditional-get since-digest protocol", {
				source: "test",
				metadata: { subtree: "projects/agent-chat" },
				scope: "bank",
			});
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			const firstRoot = await readFile(path.join(root, "MEMORY.md"), "utf8");
			const firstEntry = await readFile(path.join(root, "projects", "agent-chat", "MEMORY.md"), "utf8");

			const second = await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			expect(second.adopted).toBe(0);
			expect(second.removedStale).toBe(0);

			const secondRoot = await readFile(path.join(root, "MEMORY.md"), "utf8");
			const secondEntry = await readFile(path.join(root, "projects", "agent-chat", "MEMORY.md"), "utf8");
			expect(secondRoot).toBe(firstRoot);
			expect(secondEntry).toBe(firstEntry);
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("archives expired rows under archive/ and removes the active leaf", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			const id = memory.remember("retired wifi sensor notes", {
				source: "test",
				metadata: { subtree: "projects/sensor-automation" },
				scope: "bank",
			});
			memory.db.prepare("UPDATE working_memory SET valid_until = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);

			const result = await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			expect(result.archived).toBe(1);

			const archivedLeaf = await readFile(
				path.join(root, "archive", "projects", "sensor-automation", `${id}.md`),
				"utf8",
			);
			expect(archivedLeaf).toContain("status: archived");

			const activeDir = path.join(root, "projects", "sensor-automation");
			const names = await readdir(activeDir);
			expect(names).not.toContain(`${id}.md`);
			expect(names).toContain("MEMORY.md");
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("adopts hand-edited leaf bodies into the bank", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			const id = memory.remember("original content that will be edited", {
				source: "test",
				metadata: { subtree: "concepts" },
				scope: "bank",
			});
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });

			const leafPath = path.join(root, "concepts", `${id}.md`);
			const edited = "hand-edited replacement body";
			await writeFile(leafPath, `---\nid: ${id}\n---\n\n${edited}\n`, "utf8");
			const future = new Date("2099-01-01T00:00:00Z");
			utimesSync(leafPath, future, future);

			const result = await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			expect(result.adopted).toBe(1);

			const row = memory.get(id) as { content?: unknown } | null;
			expect(row?.content).toBe(edited);

			const leafAfter = await readFile(leafPath, "utf8");
			expect(leafAfter).toContain(edited);
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("finds memory ids by content substring", async () => {
		const memory = makeMemory();
		try {
			const id = memory.remember("deployed the conditional-get protocol", {
				source: "test",
				metadata: { subtree: "projects/agent-chat" },
				scope: "bank",
			});
			const matches = findMemoryIdsBySubstring(memory, "conditional-get", 5);
			expect(matches).toContain(id);

			const none = findMemoryIdsBySubstring(memory, "nothing-matches-this", 5);
			expect(none).toHaveLength(0);
		} finally {
			memory.close();
		}
	});

	it("restores archived rows back to the active tree", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			const id = memory.remember("archived then restored memory", {
				source: "test",
				metadata: { subtree: "concepts" },
				scope: "bank",
			});
			memory.db.prepare("UPDATE working_memory SET valid_until = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });

			expect(restoreMemoryRow(memory, id)).toBe(true);
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });

			const leaf = await readFile(path.join(root, "concepts", `${id}.md`), "utf8");
			expect(leaf).toContain("status: active");
			const archiveNames = await readdir(path.join(root, "archive", "concepts"));
			expect(archiveNames).not.toContain(`${id}.md`);
		} finally {
			cleanup(root);
			memory.close();
		}
	});
});
