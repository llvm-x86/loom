import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * A signed thinking block whose signature is foreign (cross-key auth swap,
 * proxy-minted, or otherwise unverifiable by the current endpoint) is kept by
 * the same-model replay path — demoting *unsigned* thinking cannot heal the
 * resulting `400 Invalid `signature` in `thinking` block`. On that 400 the
 * transport must strip EVERY thinking signature and retry, letting transform's
 * normal rules drop the poisoned blocks (same-model + signing target) instead
 * of replaying the invalid signature forever (and through every model
 * fallback hop).
 */

const LONG_FOREIGN_SIGNATURE = "J7LcugO+rLw65YttJsMAYyEPCwrWvRa5pq2vjQ7py671e5Q0q15fzrccKqBp".repeat(8);

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-4-5",
	name: "Claude Opus 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const contextWithForeignSignature: Context = {
	messages: [
		{ role: "user", content: "Summarize README", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Read the file, then summarise.", thinkingSignature: LONG_FOREIGN_SIGNATURE },
				{ type: "text", text: "The README covers the CLI." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		} satisfies AssistantMessage,
		{ role: "user", content: "Translate to French.", timestamp: 0 },
	] satisfies Message[],
};

function createSignatureRejection(): Error {
	const error = new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.17.content.21: Invalid `signature` in `thinking` block"},"request_id":"req_test"}',
	);
	Object.assign(error, { status: 400 });
	return error;
}

interface AnthropicWireBlock {
	type: string;
	thinking?: string;
	text?: string;
	signature?: string;
}
interface AnthropicWireMessage {
	role: string;
	content: AnthropicWireBlock[] | string;
}
function extractPriorAssistantBlocks(params: unknown): AnthropicWireBlock[] {
	if (!params || typeof params !== "object" || !("messages" in params)) return [];
	const { messages } = params as { messages?: AnthropicWireMessage[] };
	if (!Array.isArray(messages)) return [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		if (typeof msg.content === "string") continue;
		return msg.content;
	}
	return [];
}

const successEvents = [
	{
		type: "message_start",
		message: {
			id: "msg_ok",
			usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour." } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
] as const;

function successRequest() {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_ok" } });
	return {
		async withResponse() {
			return {
				data: (async function* () {
					for (const event of successEvents) yield event;
				})(),
				response,
				request_id: response.headers.get("request-id"),
			};
		},
	};
}

describe("anthropic invalid-signature strip retry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("strips every thinking signature on the 400 retry so the poisoned block leaves the wire", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const capturedPayloads: unknown[] = [];
		let attempt = 0;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			attempt += 1;
			capturedPayloads.push(params);
			if (attempt === 1) {
				return {
					async withResponse() {
						throw createSignatureRejection();
					},
				} as never;
			}
			return successRequest() as never;
		});

		const stream = streamAnthropic(model, contextWithForeignSignature, {
			apiKey: "sk-ant-test",
			providerSessionState,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(attempt).toBe(2);
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();

		// Attempt 1 replays the (foreign) signed block untouched — same-model
		// signed replay is the correct default when the signature is real.
		const firstBlocks = extractPriorAssistantBlocks(capturedPayloads[0]);
		const firstThinking = firstBlocks.find(block => block.type === "thinking");
		expect(firstThinking?.signature).toBe(LONG_FOREIGN_SIGNATURE);

		// Attempt 2 must carry NO signature anywhere: with signatures stripped,
		// the same-model + signing-target rule drops the block entirely.
		const retryBlocks = extractPriorAssistantBlocks(capturedPayloads[1]);
		expect(retryBlocks.find(block => block.type === "thinking")).toBeUndefined();
		expect(retryBlocks.some(block => block.signature !== undefined)).toBe(false);
		expect(retryBlocks.find(block => block.type === "text")?.text).toContain("The README covers the CLI.");
	});
});
