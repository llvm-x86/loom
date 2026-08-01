import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import {
	type MnemopiMemoryBatchOperationInput,
	type MnemopiMemoryEditResult,
	type MnemopiSessionState,
	planMemoryBatch,
} from "../mnemopi/state";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryEditOpSchema = type({
	op: type("'update' | 'forget' | 'invalidate' | 'replace' | 'remove'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
	"old_text?": type("string").describe("exact text to locate for replace/remove (must match exactly once)"),
	"new_text?": type("string").describe("replacement text for replace"),
});

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate' | 'replace' | 'remove'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
	"old_text?": type("string").describe("exact text to locate for replace/remove (must match exactly once)"),
	"new_text?": type("string").describe("replacement text for replace"),
	"operations?": memoryEditOpSchema
		.array()
		.describe("batch of edit operations applied atomically (all-or-nothing)"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

function clampImportance(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.max(0, Math.min(1, value));
}

function toBatchInput(params: MemoryEditParams): MnemopiMemoryBatchOperationInput[] {
	const items = params.operations && params.operations.length > 0 ? params.operations : [params];
	return items.map(item => ({
		op: item.op,
		id: item.id,
		content: item.content,
		importance: clampImportance(item.importance),
		replacementId: item.replacement_id,
		oldText: item.old_text,
		newText: item.new_text,
	}));
}

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = "read" as const;
	readonly label = "Memory Edit";
	readonly description = memoryEditDescription;
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update, forget, or invalidate Mnemopi memories";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = session.settings.get("memory.backend");
		if (backend !== "mnemopi") return null;
		return new MemoryEditTool(session);
	}

	async execute(_id: string, params: MemoryEditParams): Promise<AgentToolResult> {
		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error("Mnemopi backend is not initialised for this session.");
		}
		const singleOp =
			params.op === "update" || params.op === "forget" || params.op === "invalidate" ? params.op : null;
		if (singleOp && (!params.operations || params.operations.length === 0)) {
			return this.executeSingle(state, params, singleOp);
		}
		return this.executeBatch(state, params);
	}

	private executeSingle(
		state: MnemopiSessionState,
		params: MemoryEditParams,
		op: "update" | "forget" | "invalidate",
	): AgentToolResult {
		if (op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit update requires content or importance.");
		}

		const result = state.editScopedMemory(op, params.id, {
			content: params.content,
			importance: clampImportance(params.importance),
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}` : "";
		const text =
			result.status === "not_found"
				? `Memory ${params.id} was not found${location}.`
				: result.status === "not_editable"
					? `Memory ${params.id} is a read-only fact${location}; it cannot be edited. Read it with memory://${params.id}.`
					: `Memory ${params.id} ${result.status}${location}.`;
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}

	private executeBatch(state: MnemopiSessionState, params: MemoryEditParams): AgentToolResult {
		const inputs = toBatchInput(params);
		const plan = planMemoryBatch(inputs, id => {
			const hit = state.getScopedMemory(id);
			if (!hit) return null;
			return { content: hit.row.content, store: hit.store };
		});
		if (!plan.ok) {
			const rejected = {
				status: "rejected" as const,
				failed_index: plan.failedIndex,
				reason: plan.reason,
			};
			return {
				content: [
					{
						type: "text",
						text: `Batch rejected at operation ${plan.failedIndex}: ${plan.reason}. No changes were applied.`,
					},
				],
				details: rejected,
			};
		}
		const results: MnemopiMemoryEditResult[] = [];
		for (const commit of plan.commits) {
			results.push(
				state.editScopedMemory(commit.op, commit.id, {
					content: commit.content,
					importance: commit.importance,
					replacementId: commit.replacementId,
				}),
			);
		}
		const applied = results.filter(result => result.status !== "not_found" && result.status !== "not_editable");
		const lines = plan.commits.map((commit, index) => {
			const result = results[index];
			const location = result.bank
				? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}`
				: "";
			return `Memory ${commit.id} ${result.status}${location}.`;
		});
		return {
			content: [{ type: "text", text: `Applied ${applied.length} of ${plan.commits.length} operation(s).\n${lines.join("\n")}` }],
			details: { status: "applied", results },
		};
	}
}
