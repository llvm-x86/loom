import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core";
import {
	bankTreeDir,
	findMemoryIdsBySubstring,
	readTreeWriteLog,
	renderMemoryTree,
	renderMemoryTreeIndex,
	restoreMemoryRow,
} from "../tree";

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

			const result = await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root, archiveGcDays: 0 });
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
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root, archiveGcDays: 0 });

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

	it("garbage-collects archived rows past the horizon and drops their leaves", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			const id = memory.remember("gc-me old archived fact", {
				source: "test",
				metadata: { subtree: "concepts" },
				scope: "bank",
			});
			memory.db.prepare("UPDATE working_memory SET valid_until = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);

			const result = await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			expect(result.gc).toBe(1);
			expect(result.archived).toBe(0);
			expect(memory.get(id)).toBeNull();
			await expect(readFile(path.join(root, "archive", "concepts", `${id}.md`), "utf8")).rejects.toThrow();
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("caps the subtree entry point at entryRows and notes the overflow", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			for (let i = 0; i < 5; i++) {
				memory.remember(`capped leaf number ${i}`, {
					source: "test",
					metadata: { subtree: "bigsub" },
					scope: "bank",
				});
			}
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root, entryRows: 3 });

			const entry = await readFile(path.join(root, "bigsub", "MEMORY.md"), "utf8");
			expect(entry).toContain("2 older leaf(ren) not listed (entry point capped at 3 rows)");
			const names = await readdir(path.join(root, "bigsub"));
			expect(names.filter(n => n.endsWith(".md") && n !== "MEMORY.md")).toHaveLength(5);
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("records every reconcile pass in the tree write log", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			memory.remember("logged fact", { source: "test", scope: "bank" });
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });

			const log = readTreeWriteLog(memory, 10);
			expect(log).toHaveLength(2);
			expect(log[0].bank).toBe(memory.bank);
			expect(log[0].leaves).toBeGreaterThanOrEqual(1);
			expect(log[0].at >= log[1].at).toBe(true);
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("re-materialises the tree after the whole root is deleted", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			memory.remember("survives deletion of the tree", {
				source: "test",
				metadata: { subtree: "concepts" },
				scope: "bank",
			});
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			rmSync(root, { recursive: true, force: true });

			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: root });
			const [id] = findMemoryIdsBySubstring(memory, "survives deletion", 5);
			const leaf = await readFile(path.join(root, "concepts", `${id}.md`), "utf8");
			expect(leaf).toContain("status: active");
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("renders two banks into their own directories without clobbering entry points or leaves", async () => {
		const memoryA = new Mnemopi({ dbPath: ":memory:", sessionId: "tree-test", bank: "bank-a" });
		const memoryB = new Mnemopi({ dbPath: ":memory:", sessionId: "tree-test", bank: "bank-b" });
		const root = makeRoot();
		try {
			const idA = memoryA.remember("bank A's only fact", {
				source: "test",
				metadata: { subtree: "concepts" },
				scope: "bank",
			});
			const idB = memoryB.remember("bank B's only fact", {
				source: "test",
				metadata: { subtree: "concepts" },
				scope: "bank",
			});

			const dirA = bankTreeDir(root, "bank-a");
			const dirB = bankTreeDir(root, "bank-b");
			if (!dirA || !dirB) throw new Error("expected canonical bank ids to pass the path guard");
			await renderMemoryTree({ memory: memoryA, bank: "bank-a", treeRoot: dirA });
			await renderMemoryTree({ memory: memoryB, bank: "bank-b", treeRoot: dirB });

			const rootA = await readFile(path.join(dirA, "MEMORY.md"), "utf8");
			const rootB = await readFile(path.join(dirB, "MEMORY.md"), "utf8");
			expect(rootA).toContain("# Memory tree: bank-a");
			expect(rootB).toContain("# Memory tree: bank-b");

			const leafA = await readFile(path.join(dirA, "concepts", `${idA}.md`), "utf8");
			const leafB = await readFile(path.join(dirB, "concepts", `${idB}.md`), "utf8");
			expect(leafA).toContain("bank A's only fact");
			expect(leafB).toContain("bank B's only fact");
			// Neither bank's leaves crossed into the other bank's directory.
			expect(await readdir(path.join(dirA, "concepts"))).not.toContain(`${idB}.md`);
			expect(await readdir(path.join(dirB, "concepts"))).not.toContain(`${idA}.md`);

			await renderMemoryTreeIndex(root);
			const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
			expect(index).toContain("# Memory index");
			expect(index).toContain("bank-a");
			expect(index).toContain("bank-b");
			expect(index).not.toContain("# Memory tree:"); // never confused with a per-bank root entry
		} finally {
			cleanup(root);
			memoryA.close();
			memoryB.close();
		}
	});

	it("excludes legacy flat subtree dirs and archive/ from the cross-project index", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			// Simulate the pre-fix flat renderer's leftovers: subtree dirs with
			// their own MEMORY.md sitting directly under treeRoot, plus a stray
			// atomic-write temp file. None of these are banks.
			await mkdir(path.join(root, "concepts"), { recursive: true });
			await writeFile(path.join(root, "concepts", "MEMORY.md"), "# Memory: concepts\n\nlegacy flat entry\n", "utf8");
			await mkdir(path.join(root, "archive"), { recursive: true });
			await writeFile(path.join(root, "MEMORY.md.tmp-12345"), "leftover atomic-write temp", "utf8");

			const dir = bankTreeDir(root, memory.bank);
			if (!dir) throw new Error("expected canonical bank id to pass the path guard");
			memory.remember("a real bank fact", { source: "test", metadata: { subtree: "concepts" }, scope: "bank" });
			await renderMemoryTree({ memory, bank: memory.bank, treeRoot: dir });
			await renderMemoryTreeIndex(root);

			const index = await readFile(path.join(root, "MEMORY.md"), "utf8");
			expect(index).toContain(memory.bank);
			expect(index).not.toContain("concepts |");
			expect(index).not.toContain("archive |");
			expect(index).not.toContain("tmp-12345");
		} finally {
			cleanup(root);
			memory.close();
		}
	});

	it("rejects a bank id that would escape treeRoot via traversal or a separator", () => {
		expect(bankTreeDir("/tmp/tree", "../escape")).toBeUndefined();
		expect(bankTreeDir("/tmp/tree", "a/b")).toBeUndefined();
		expect(bankTreeDir("/tmp/tree", "..")).toBeUndefined();
		expect(bankTreeDir("/tmp/tree", "valid-bank_1")).toBe(path.join("/tmp/tree", "valid-bank_1"));
	});

	it("cleans up the atomic-write temp file when the write is interrupted", async () => {
		const memory = makeMemory();
		const root = makeRoot();
		try {
			memory.remember("triggers a write", { source: "test", metadata: { subtree: "concepts" }, scope: "bank" });
			// A directory at the destination path makes `rename` fail after the
			// temp file is written, simulating an interrupted atomic write.
			await mkdir(path.join(root, "MEMORY.md"), { recursive: true });
			await expect(renderMemoryTree({ memory, bank: memory.bank, treeRoot: root })).rejects.toThrow();

			const names = await readdir(root);
			expect(names.some(n => n.startsWith("MEMORY.md.tmp-"))).toBe(false);
		} finally {
			cleanup(root);
			memory.close();
		}
	});
});
