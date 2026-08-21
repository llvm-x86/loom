import { describe, expect, test } from "bun:test";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { isOpenCodeZenDeepseekAlias } from "@oh-my-pi/pi-catalog/identity/family";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function zenCompletionsSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		id: "some-model",
		name: "Some Model",
		api: "openai-completions",
		provider: "opencode-zen",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

describe("isOpenCodeZenDeepseekAlias", () => {
	test("matches Ox Alpha by id and display name", () => {
		expect(isOpenCodeZenDeepseekAlias("opencode-zen", "x-preview-f-free", "Ox Alpha Free (Unlimited)")).toBe(true);
		expect(isOpenCodeZenDeepseekAlias("opencode-zen", "some-unrelated-id", "Ox Alpha")).toBe(true);
	});

	test("matches Big Pickle by id and display name", () => {
		expect(isOpenCodeZenDeepseekAlias("opencode-zen", "big-pickle", "Big Pickle")).toBe(true);
		expect(isOpenCodeZenDeepseekAlias("opencode-zen", "stealth-drop", "big pickle")).toBe(true);
	});

	test("does not match other providers or unrelated names (no substring overreach)", () => {
		expect(isOpenCodeZenDeepseekAlias("opencode-go", "x-preview-f-free", "Ox Alpha Free (Unlimited)")).toBe(false);
		expect(isOpenCodeZenDeepseekAlias("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro")).toBe(false);
		expect(isOpenCodeZenDeepseekAlias("opencode-zen", "claude-opus-4-8", "Claude Opus 4.8")).toBe(false);
		expect(isOpenCodeZenDeepseekAlias("opencode-zen", "x-preview-f-free", "")).toBe(true);
	});
});

describe("bundled x-preview-f-free catalog entry", () => {
	const model = getBundledModel("opencode-zen", "x-preview-f-free");

	test("exists with models.dev-authoritative metadata", () => {
		expect(model).toBeDefined();
		expect(model?.name).toBe("Ox Alpha Free (Unlimited)");
		expect(model?.reasoning).toBe(true);
		expect(model?.contextWindow).toBe(1_000_000);
		expect(model?.maxTokens).toBe(131_072);
	});

	test("resolves DeepSeek-family replay compat (the intermittent-stop fix)", () => {
		expect(model).toBeDefined();
		const compat = model!.compat as import("@oh-my-pi/pi-catalog/types").ResolvedOpenAICompat;
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.requiresReasoningContentForAllAssistantTurns).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
	});

	test("widens the stream idle watchdog for free-tier queueing gaps", () => {
		expect(model).toBeDefined();
		expect((model!.compat as import("@oh-my-pi/pi-catalog/types").ResolvedOpenAICompat).streamIdleTimeoutMs).toBe(
			300_000,
		);
	});
});

describe("buildOpenAICompat ox alpha classification", () => {
	test("classifies dynamic bare-record specs as DeepSeek family when reasoning is flagged", () => {
		// Runtime discovery merges the bundled reference, but a spec that lost
		// its reference must still classify once `reasoning` is known.
		const compat = buildOpenAICompat(
			zenCompletionsSpec({ id: "x-preview-f-free", name: "Ox Alpha Free (Unlimited)", reasoning: true }),
		);
		expect(compat.requiresReasoningContentForAllAssistantTurns).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(compat.streamIdleTimeoutMs).toBe(300_000);
	});

	test("leaves non-reasoning specs without replay requirements", () => {
		const compat = buildOpenAICompat(zenCompletionsSpec({ id: "x-preview-f-free", reasoning: false }));
		expect(compat.requiresReasoningContentForAllAssistantTurns).toBe(false);
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
	});

	test("keeps big-pickle behavior unchanged through the shared predicate", () => {
		const compat = buildOpenAICompat(zenCompletionsSpec({ id: "big-pickle", name: "Big Pickle", reasoning: true }));
		expect(compat.requiresReasoningContentForAllAssistantTurns).toBe(true);
		expect(compat.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		expect(compat.streamIdleTimeoutMs).toBe(300_000);
	});
});
