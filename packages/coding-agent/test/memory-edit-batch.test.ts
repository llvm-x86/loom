import { describe, expect, it } from "bun:test";
import type { MnemopiScopedMemoryHit, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";

interface FakeRow {
	content: string;
	store: "working" | "episodic" | "fact";
	importance?: number;
	invalidated?: boolean;
}

interface EditCall {
	op: string;
	id: string;
	options: { content?: string; importance?: number; replacementId?: string };
}

function makeSession(rows: Map<string, FakeRow>, calls: EditCall[]): ToolSession {
	const state = {
		getScopedMemory(id: string): MnemopiScopedMemoryHit | null {
			const row = rows.get(id);
			if (!row) return null;
			return {
				bank: "test-bank",
				store: row.store,
				row: {
					id,
					content: row.content,
					source: null,
					timestamp: null,
					importance: row.importance ?? null,
					veracity: null,
					created_at: null,
					session_id: null,
					memory_type: null,
					metadata: null,
				},
			};
		},
		editScopedMemory(
			op: "update" | "forget" | "invalidate",
			id: string,
			options: { content?: string; importance?: number; replacementId?: string },
		) {
			calls.push({ op, id, options });
			const row = rows.get(id);
			if (!row) return { status: "not_found" as const };
			if (row.store === "fact") return { status: "not_editable" as const, bank: "test-bank", store: row.store };
			if ((op === "update" || op === "forget") && row.store !== "working")
				return { status: "not_found" as const, bank: "test-bank", store: row.store };
			if (op === "update") {
				if (options.content !== undefined) row.content = options.content;
				if (options.importance !== undefined) row.importance = options.importance;
				return { status: "updated" as const, bank: "test-bank", store: row.store };
			}
			if (op === "forget") {
				rows.delete(id);
				return { status: "deleted" as const, bank: "test-bank", store: row.store };
			}
			row.invalidated = true;
			return { status: "invalidated" as const, bank: "test-bank", store: row.store };
		},
	};
	// Stub session: MemoryEditTool only touches getMnemopiSessionState here.
	return { getMnemopiSessionState: () => state } as unknown as ToolSession;
}

function makeTool(rows: Map<string, FakeRow>, calls: EditCall[]): MemoryEditTool {
	return new MemoryEditTool(makeSession(rows, calls));
}

describe("memory_edit batch operations", () => {
	it("applies a mixed valid batch (replace, remove, update, forget) atomically", async () => {
		const rows = new Map<string, FakeRow>([
			["a", { content: "alpha bravo charlie", store: "working" }],
			["b", { content: "one two three", store: "working" }],
			["c", { content: "stale note", store: "working" }],
		]);
		const calls: EditCall[] = [];
		const tool = makeTool(rows, calls);
		const result = await tool.execute("t1", {
			op: "replace",
			id: "a",
			old_text: "bravo",
			new_text: "BRAVO",
			operations: [
				{ op: "replace", id: "a", old_text: "bravo", new_text: "BRAVO" },
				{ op: "remove", id: "b", old_text: "two " },
				{ op: "update", id: "b", importance: 0.9 },
				{ op: "forget", id: "c" },
			],
		});
		expect(result.details).toMatchObject({ status: "applied" });
		expect(rows.get("a")?.content).toBe("alpha BRAVO charlie");
		expect(rows.get("b")?.content).toBe("one three");
		expect(rows.get("b")?.importance).toBe(0.9);
		expect(rows.has("c")).toBe(false);
		expect(calls).toHaveLength(4);
	});

	it("rejects the whole batch when old_text matches zero times, reporting the failing index", async () => {
		const rows = new Map<string, FakeRow>([
			["a", { content: "alpha bravo", store: "working" }],
			["b", { content: "one two", store: "working" }],
		]);
		const calls: EditCall[] = [];
		const tool = makeTool(rows, calls);
		const result = await tool.execute("t2", {
			op: "replace",
			id: "a",
			old_text: "alpha",
			new_text: "ALPHA",
			operations: [
				{ op: "replace", id: "a", old_text: "alpha", new_text: "ALPHA" },
				{ op: "replace", id: "b", old_text: "missing", new_text: "x" },
			],
		});
		expect(result.details).toMatchObject({ status: "rejected", failed_index: 1 });
		expect(calls).toHaveLength(0);
		expect(rows.get("a")?.content).toBe("alpha bravo");
		expect(rows.get("b")?.content).toBe("one two");
	});

	it("rejects the whole batch when old_text matches more than once", async () => {
		const rows = new Map<string, FakeRow>([["a", { content: "dup dup dup", store: "working" }]]);
		const calls: EditCall[] = [];
		const tool = makeTool(rows, calls);
		const result = await tool.execute("t3", {
			op: "replace",
			id: "a",
			old_text: "dup",
			new_text: "x",
		});
		expect(result.details).toMatchObject({ status: "rejected", failed_index: 0 });
		const details = result.details as { reason: string };
		expect(details.reason).toContain("3 times");
		expect(calls).toHaveLength(0);
		expect(rows.get("a")?.content).toBe("dup dup dup");
	});

	it("leaves the store untouched when a later op in a mixed batch fails", async () => {
		const rows = new Map<string, FakeRow>([
			["a", { content: "alpha bravo", store: "working" }],
			["b", { content: "one two", store: "working" }],
		]);
		const calls: EditCall[] = [];
		const tool = makeTool(rows, calls);
		const result = await tool.execute("t4", {
			op: "replace",
			id: "a",
			old_text: "bravo",
			new_text: "BRAVO",
			operations: [
				{ op: "replace", id: "a", old_text: "bravo", new_text: "BRAVO" },
				{ op: "remove", id: "b", old_text: "two" },
				{ op: "replace", id: "ghost", old_text: "x", new_text: "y" },
			],
		});
		expect(result.details).toMatchObject({ status: "rejected", failed_index: 2 });
		expect(calls).toHaveLength(0);
		expect(rows.get("a")?.content).toBe("alpha bravo");
		expect(rows.get("b")?.content).toBe("one two");
	});

	it("rejects edits against read-only fact memories", async () => {
		const rows = new Map<string, FakeRow>([["f", { content: "fact row", store: "fact" }]]);
		const calls: EditCall[] = [];
		const tool = makeTool(rows, calls);
		const result = await tool.execute("t5", {
			op: "remove",
			id: "f",
			old_text: "fact",
		});
		expect(result.details).toMatchObject({ status: "rejected", failed_index: 0 });
		expect(calls).toHaveLength(0);
	});
});

describe("memory_edit single-op regression", () => {
	it("keeps the legacy update path byte-for-byte (no planner involvement)", async () => {
		const rows = new Map<string, FakeRow>([["a", { content: "old content", store: "working" }]]);
		const calls: EditCall[] = [];
		const tool = makeTool(rows, calls);
		const result = await tool.execute("t6", { op: "update", id: "a", content: "new content", importance: 5 });
		expect(result.content).toEqual([
			{ type: "text", text: "Memory a updated in bank test-bank (working)." },
		]);
		expect(result.details).toEqual({ status: "updated", bank: "test-bank", store: "working" });
		// importance is clamped exactly as before
		expect(calls).toEqual([{ op: "update", id: "a", options: { content: "new content", importance: 1, replacementId: undefined } }]);
		expect(rows.get("a")?.content).toBe("new content");
	});

	it("still throws when update carries neither content nor importance", async () => {
		const rows = new Map<string, FakeRow>([["a", { content: "x", store: "working" }]]);
		const tool = makeTool(rows, []);
		await expect(tool.execute("t7", { op: "update", id: "a" })).rejects.toThrow(
			"memory_edit update requires content or importance.",
		);
	});

	it("keeps not_found and not_editable single-op messages", async () => {
		const rows = new Map<string, FakeRow>([["f", { content: "fact row", store: "fact" }]]);
		const tool = makeTool(rows, []);
		const missing = await tool.execute("t8", { op: "forget", id: "ghost" });
		expect(missing.content).toEqual([{ type: "text", text: "Memory ghost was not found." }]);
		const fact = await tool.execute("t9", { op: "invalidate", id: "f" });
		expect(fact.content).toEqual([
			{
				type: "text",
				text: "Memory f is a read-only fact in bank test-bank (fact); it cannot be edited. Read it with memory://f.",
			},
		]);
	});
});
