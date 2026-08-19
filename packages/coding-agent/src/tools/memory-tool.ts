import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { parseDeclaredBankRepo } from "../mnemopi/config";
import { findMemoryIdsBySubstring } from "../mnemopi/tree";
import memoryToolDescription from "../prompts/tools/memory.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryToolSchema = type({
	action: type("'add' | 'replace' | 'remove' | 'restore'").describe(
		"add: record a new memory. replace: update an existing memory's content. remove: delete a memory. restore: bring an archived memory back to active",
	),
	"content?": type("string").describe("text to remember (add) or new text for the matched memory (replace)"),
	"match?": type("string").describe(
		"substring identifying the existing memory to replace/remove/restore (first content match wins)",
	),
	"target?": type("string").describe(
		"subtree to file the memory under for add, e.g. projects/agent-chat, concepts, people, skills",
	),
	"repo?": type("string").describe(
		"owner/repo slug the memory belongs to, e.g. Family-Fun-Group/SkyRail. Pins the bank this session writes/recalls memory from for the rest of the session — sticky, so later calls may omit it",
	),
	"context?": type("string").describe("source context to attach (add only)"),
	"importance?": type("number").describe("0..1 priority hint (add only)"),
});

type MnemopiSessionStateType = NonNullable<ReturnType<NonNullable<ToolSession["getMnemopiSessionState"]>>>;

export type MemoryToolParams = typeof memoryToolSchema.infer;

function clampImportance(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.max(0, Math.min(1, value));
}

function memoryNotFound(params: MemoryToolParams): AgentToolResult {
	return {
		content: [
			{
				type: "text",
				text: `No memory matched "${params.match}". Run read on the memory tree (MEMORY.md) to find the right match string.`,
			},
		],
		details: { status: "not_found" },
		useless: true,
	};
}
function failure(text: string, details: Record<string, unknown> = {}): AgentToolResult {
	return {
		content: [{ type: "text", text }],
		details,
		useless: true,
	};
}

/**
 * The single agent-facing memory write channel. The agent never touches the
 * memory tree files: this tool mutates the bank, and the background renderer
 * (consolidate / retain / enqueue passes) writes the leaf + entry points.
 */
export class MemoryTool implements AgentTool<typeof memoryToolSchema> {
	readonly name = "memory";
	readonly approval = "read" as const;
	readonly label = "Memory";
	readonly description = memoryToolDescription;
	readonly parameters = memoryToolSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Request the background memory system to add, replace, remove, or restore a memory";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryTool | null {
		return session.settings.get("memory.backend") === "mnemopi" ? new MemoryTool(session) : null;
	}

	async execute(_id: string, params: MemoryToolParams): Promise<AgentToolResult> {
		const state = await (this.session.awaitMnemopiSessionState?.() ?? this.session.getMnemopiSessionState?.());
		if (!state) {
			throw new Error("Mnemopi backend is not initialised for this session.");
		}
		if (params.repo !== undefined) {
			const slug = parseDeclaredBankRepo(params.repo);
			if (!slug) {
				return failure(
					`memory repo must look like "owner/repo" (got ${JSON.stringify(params.repo)}); the memory was not stored.`,
				);
			}
			// Sticky for the rest of the session (see MnemopiSessionState.declareBankRepo)
			// — applied before this same write so it lands in the declared bank too.
			await state.declareBankRepo(slug);
		}
		if (params.action === "add") {
			const content = params.content?.trim();
			if (!content) {
				return failure("memory add requires non-empty content.");
			}
			const target = params.target?.trim() || undefined;
			const memoryId = state.rememberScoped(content, {
				source: "memory-tool",
				importance: clampImportance(params.importance),
				metadata: {
					subtree: target ?? null,
					context: params.context?.trim() ?? null,
					tool: "memory",
				},
				scope: "bank",
				extract: true,
				extractEntities: true,
				veracity: "user",
				memoryType: "fact",
			});
			if (!memoryId) {
				return failure("The memory system rejected the request; nothing was stored.");
			}
			state.markTreeChange();
			this.scheduleRender(state);
			return {
				content: [
					{
						type: "text",
						text: `Memory requested (${memoryId})${target ? ` under ${target}` : ""}. The background renderer writes the leaf + entry points on its next pass; read MEMORY.md in the memory tree to see it.`,
					},
				],
				details: { status: "queued", id: memoryId },
			};
		}

		if (!params.match || params.match.trim() === "") {
			return failure(`memory ${params.action} requires a match substring.`);
		}

		const targets = [state.getScopedRetainTarget(), ...state.getScopedRecallTargets()];
		const ids: string[] = [];
		for (const target of targets) {
			for (const id of findMemoryIdsBySubstring(target.memory, params.match, 1)) {
				if (!ids.includes(id)) ids.push(id);
			}
		}
		const memoryId = ids[0];
		if (!memoryId) return memoryNotFound(params);

		if (params.action === "replace") {
			const content = params.content?.trim();
			if (!content) return failure("memory replace requires non-empty content.");
			const result = state.editScopedMemory("update", memoryId, { content });
			if (result.status === "not_found" || result.status === "not_editable") return memoryNotFound(params);
			state.markTreeChange();
			this.scheduleRender(state);
			return {
				content: [
					{
						type: "text",
						text: `Memory ${memoryId} replaced (${result.status}); the background renderer updates the leaf on its next pass.`,
					},
				],
				details: result,
			};
		}

		if (params.action === "remove") {
			const result = state.editScopedMemory("forget", memoryId);
			if (result.status === "not_found" || result.status === "not_editable") return memoryNotFound(params);
			state.markTreeChange();
			this.scheduleRender(state);
			return {
				content: [
					{
						type: "text",
						text: `Memory ${memoryId} removed (${result.status}); its leaf disappears on the next background pass.`,
					},
				],
				details: result,
			};
		}

		// restore
		if (state.restoreScopedMemory(memoryId)) {
			state.markTreeChange();
			this.scheduleRender(state);
			return {
				content: [
					{
						type: "text",
						text: `Memory ${memoryId} restored; it renders back under the active tree on the next background pass.`,
					},
				],
				details: { status: "restored", id: memoryId },
			};
		}
		return memoryNotFound(params);
	}

	private scheduleRender(state: MnemopiSessionStateType): void {
		void state.renderMemoryTree().catch((error: unknown) => {
			logger.warn("Mnemopi: memory tree render after memory tool failed.", { error: String(error) });
		});
	}
}
