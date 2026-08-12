import { describe, expect, it } from "bun:test";
import { type OpenAICompletionsOptions, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type Context, type Model, type FetchImpl } from "@oh-my-pi/pi-ai/types";
const model = getBundledModel<"openai-completions">("xai", "grok-code-fast-1");
if (!model) throw new Error("Expected bundled xAI Grok model");
if (model.api !== "openai-completions") throw new Error(`Expected Chat Completions model, received ${model.api}`);
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function chatCompletionsSse(target: Model): Response {
	const chunk = (delta: unknown, finishReason: string | null) =>
		JSON.stringify({
			id: "chatcmpl-affinity",
			object: "chat.completion.chunk",
			created: 0,
			model: target.id,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});

	return new Response(
		`data: ${chunk({ role: "assistant", content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

async function captureRequestHeaders(
	target: Model<"openai-completions">,
	options: OpenAICompletionsOptions,
): Promise<Headers> {
	let requestHeaders: Headers | undefined;
	const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request
				? new Request(input, init)
				: new Request(input instanceof URL ? input.href : input, init);
		requestHeaders = request.headers;
		return chatCompletionsSse(target);
	};

	await streamOpenAICompletions(target, context, {
		apiKey: "test-key",
		...options,
		fetch: fetchMock,
	}).result();

	if (!requestHeaders) throw new Error("Expected a serialized Chat Completions request");
	return requestHeaders;
}

const fireworksModel = getBundledModel<"openai-completions">("fireworks", "deepseek-v4-flash");
if (!fireworksModel) throw new Error("Expected bundled Fireworks model");
if (fireworksModel.api !== "openai-completions")
	throw new Error(`Expected Chat Completions model, received ${fireworksModel.api}`);

async function captureFireworksRequestHeaders(options: OpenAICompletionsOptions): Promise<Headers> {
	return captureRequestHeaders(fireworksModel, options);
}

describe("openai-completions xAI cache affinity", () => {
	const cases: Array<{
		name: string;
		options: OpenAICompletionsOptions;
		expectedHeader: string | null;
	}> = [
		{
			name: "uses sessionId when no prompt cache key is provided",
			options: { sessionId: "session-fallback" },
			expectedHeader: "session-fallback",
		},
		{
			name: "keeps the prompt cache key stable across a distinct side-channel session",
			options: { promptCacheKey: "stable-cache-key", sessionId: "side-channel-session" },
			expectedHeader: "stable-cache-key",
		},
		{
			name: "omits automatic affinity when caching is disabled",
			options: {
				promptCacheKey: "disabled-cache-key",
				sessionId: "disabled-session",
				cacheRetention: "none",
			},
			expectedHeader: null,
		},
		{
			name: "preserves a caller-provided mixed-case affinity header",
			options: {
				promptCacheKey: "automatic-cache-key",
				sessionId: "automatic-session",
				headers: { "X-Grok-Conv-Id": "caller-affinity" },
			},
			expectedHeader: "caller-affinity",
		},
	];

	for (const { name, options, expectedHeader } of cases) {
		it(name, async () => {
			const headers = await captureRequestHeaders(model, options);

			expect(headers.get("x-grok-conv-id")).toBe(expectedHeader);
		});
	}
});

describe("openai-completions Fireworks x-session-affinity", () => {
	const cases: Array<{
		name: string;
		options: OpenAICompletionsOptions;
		expectedHeader: string | null;
	}> = [
		{
			name: "uses the stable session id for KV-cache node affinity",
			options: { sessionId: "conversation-42" },
			expectedHeader: "conversation-42",
		},
		{
			name: "prioritizes an explicit prompt cache key over the session id",
			options: { promptCacheKey: "stable-cache-key", sessionId: "side-channel-session" },
			expectedHeader: "stable-cache-key",
		},
		{
			name: "omits affinity when caching is disabled",
			options: {
				promptCacheKey: "disabled-cache-key",
				sessionId: "disabled-session",
				cacheRetention: "none",
			},
			expectedHeader: null,
		},
		{
			name: "preserves a caller-provided x-session-affinity header",
			options: {
				promptCacheKey: "automatic-cache-key",
				sessionId: "automatic-session",
				headers: { "x-session-affinity": "caller-affinity" },
			},
			expectedHeader: "caller-affinity",
		},
	];

	for (const { name, options, expectedHeader } of cases) {
		it(name, async () => {
			const headers = await captureFireworksRequestHeaders(options);

			expect(headers.get("x-session-affinity")).toBe(expectedHeader);
		});
	}
 });
