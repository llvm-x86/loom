import { describe, expect, it } from "bun:test";
import type { Context, Model, UserMessage } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-catalog";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { prompt } from "@oh-my-pi/pi-utils";
import interruptedThinkingTemplate from "../prompts/system/interrupted-thinking.md" with { type: "text" };
import { redactInterruptedThinkingForModel } from "./interrupted-thinking-replay";

function model(overrides: Partial<ModelSpec<"anthropic-messages">> = {}): Model {
	return buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">);
}

const REASONING = "Let me think: the peer's hunks in state.ts do not overlap mine, so a plain merge works.";
const notice = prompt.render(interruptedThinkingTemplate, { reasoning: REASONING });

function context(messages: Context["messages"]): Context {
	return { systemPrompt: ["sys"], messages };
}

/** Text of a user message's Nth content block (or the whole string content). */
function userText(message: Context["messages"][number] | undefined, index = 0): string {
	if (message?.role !== "user") throw new Error("expected a user message");
	if (typeof message.content === "string") return message.content;
	const block = message.content[index];
	if (block?.type !== "text") throw new Error("expected a text block");
	return block.text;
}

describe("redactInterruptedThinkingForModel", () => {
	it("replaces the notice's reasoning for a signing Anthropic target, keeping the surrounding user text", () => {
		const user: UserMessage = { role: "user", content: `yes merge into main please.\n\n${notice}`, timestamp: 0 };
		const out = redactInterruptedThinkingForModel(context([user]), model());
		const text = userText(out.messages[0]);
		expect(text.startsWith("yes merge into main please.")).toBe(true);
		expect(text).not.toContain(REASONING);
		expect(text).toContain('<system-notice type="interrupted-thinking">');
		expect(text).toContain("interrupted before it finished");
		expect(text.toLowerCase()).not.toContain("reasoning");
		expect(text.endsWith("</system-notice>")).toBe(true);
	});

	it("redacts inside text blocks and leaves non-text blocks and other messages untouched by identity", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const plain: UserMessage = { role: "user", content: "hello", timestamp: 0 };
		const mixed: UserMessage = { role: "user", content: [{ type: "text", text: notice }, image], timestamp: 1 };
		const out = redactInterruptedThinkingForModel(context([plain, mixed]), model());
		expect(out.messages[0]).toBe(plain);
		const redacted = out.messages[1];
		expect(redacted).not.toBe(mixed);
		if (redacted?.role !== "user" || typeof redacted.content === "string") throw new Error("shape");
		expect(redacted.content[1]).toBe(image);
		expect(userText(redacted)).not.toContain(REASONING);
	});

	it("is the identity for non-Anthropic and non-signing targets, and when no notice is present", () => {
		const user: UserMessage = { role: "user", content: notice, timestamp: 0 };
		const ctx = context([user]);
		expect(
			redactInterruptedThinkingForModel(
				ctx,
				model({ provider: "custom-anthropic", baseUrl: "https://llm.example.com/anthropic" }),
			),
		).toBe(ctx);
		const noNotice = context([{ role: "user", content: "proceed", timestamp: 0 }]);
		expect(redactInterruptedThinkingForModel(noNotice, model())).toBe(noNotice);
	});
});
