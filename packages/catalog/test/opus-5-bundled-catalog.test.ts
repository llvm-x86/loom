import { describe, expect, it } from "bun:test";
import { Effort } from "../src/effort";
import { supportsAdaptiveThinkingDisplay } from "../src/identity/family";
import { getBundledModel } from "../src/models";

describe("Claude Opus 5 bundled catalog", () => {
	it("exposes the native Anthropic entry with Opus-5 pricing and adaptive thinking", () => {
		const model = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5");

		expect(model).toBeDefined();
		expect(model.id).toBe("claude-opus-5");
		expect(model.api).toBe("anthropic-messages");
		expect(model.provider).toBe("anthropic");
		expect(model.cost?.input).toBe(5);
		expect(model.cost?.output).toBe(25);
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);

		expect(model.thinking?.mode).toBe("anthropic-adaptive");
		expect(model.thinking?.efforts).toContain(Effort.XHigh);
		expect(model.thinking?.efforts).toContain(Effort.Max);
		expect(model.thinking?.supportsDisplay).toBe(true);
	});

	it("derives the Opus 4.7+/4.8+ capability gates from the classifier", () => {
		const model = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5");

		// Opus 4.7+ reject temperature/top_p/top_k with a 400.
		expect(model.compat?.supportsSamplingParams).toBe(false);
		// Mid-conversation `system` role is accepted starting Opus 4.8+.
		expect(model.compat?.supportsMidConversationSystem).toBe(true);
		// Adaptive thinking `display` is supported Opus 4.7+.
		expect(supportsAdaptiveThinkingDisplay("claude-opus-5")).toBe(true);
	});

	it("ships the Bedrock entry as a pinned single-segment snapshot", () => {
		const model = getBundledModel("amazon-bedrock", "anthropic.claude-opus-5");

		expect(model).toBeDefined();
		expect(model.id).toBe("anthropic.claude-opus-5");
		expect(model.api).toBe("bedrock-converse-stream");
		expect(model.thinking?.mode).toBe("anthropic-adaptive");
	});
});
