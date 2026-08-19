import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ToolSession } from ".";

const memoryRecallSchema = type({
	"query?": type("string").describe(
		"natural language search query; only optional when listBanks is true",
	),
	"repo?": type("string").describe(
		'mnemopi backend only: search ANOTHER project\'s memory bank instead of this session\'s own. Accepts an owner/repo slug (e.g. "octocat/hello-world") or a literal bank id from listBanks. Read-only — never writes there. Run with listBanks first if unsure the bank exists.',
	),
	"listBanks?": type("boolean").describe(
		"mnemopi backend only: list every memory bank on disk with its row count instead of searching — use this to discover other projects' banks before passing repo",
	),
});

export type MemoryRecallParams = typeof memoryRecallSchema.infer;

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	readonly description = recallDescription;
	readonly parameters = memoryRecallSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = session.settings.get("memory.backend");
		// Hindsight has always exposed recall. Mnemopi sessions read their OWN
		// memories as files from the tree, but the SQLite index is the only way
		// to search another project's bank (its files may not even be local), so
		// recall stays available there for cross-bank reads and bank discovery.
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = this.session.settings.get("memory.backend");
			if (backend === "mnemopi") {
				const state = await (this.session.awaitMnemopiSessionState?.() ?? this.session.getMnemopiSessionState?.());
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}
				try {
					if (params.listBanks) {
						const banks = state.listAvailableBanks();
						if (banks.length === 0) {
							return {
								content: [{ type: "text", text: "No memory banks found on disk." }],
								details: {},
								useless: true,
							};
						}
						const lines = banks
							.map(
								b =>
									`- ${b.bank}${b.isOwnScope ? " (this session's own scope)" : ""}: ${b.memories} ${b.memories === 1 ? "memory" : "memories"}`,
							)
							.join("\n");
						return {
							content: [
								{
									type: "text",
									text: `Memory banks on disk (each also readable at \`${state.config.treeRoot}/<bank>/\`):\n\n${lines}`,
								},
							],
							details: {},
						};
					}

					const query = params.query?.trim();
					if (!query) {
						throw new Error("recall requires a non-empty query unless listBanks is true.");
					}

					const { bank, results } = params.repo
						? await state.recallFromBank(query, params.repo)
						: { bank: state.config.bank, results: await state.recallResultsScoped(query) };

					if (results.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: params.repo ? `No relevant memories found in bank "${bank}".` : "No relevant memories found.",
								},
							],
							details: {},
							useless: true,
						};
					}
					const formatted = state.formatScopedRecallWithIds(results);
					const scopeNote = params.repo ? ` in bank "${bank}"` : "";
					return {
						content: [
							{
								type: "text",
								text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"}${scopeNote} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
							},
						],
						details: {},
					};
				} catch (err) {
					logger.warn("recall failed", {
						backend: "mnemopi",
						bank: state.config.bank,
						repo: params.repo,
						error: String(err),
					});
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}
			const query = params.query?.trim();
			if (!query) {
				throw new Error("recall requires a non-empty query.");
			}

			try {
				const response = await state.client.recall(state.bankId, query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
						useless: true,
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
