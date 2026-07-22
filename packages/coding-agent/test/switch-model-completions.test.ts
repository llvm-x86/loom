import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildModelArgumentCompletions } from "../src/slash-commands/builtin-registry";

function model(provider: string, id: string, name: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const TEST_MODELS: Model<Api>[] = [
	model("kimi-code", "k3", "K3"),
	model("anthropic", "claude-opus-4-8", "Opus 4.8"),
	model("cursor", "composer-2.5-fast", "Composer 2.5 Fast"),
];

const fakeModelRegistry = { getAvailable: () => TEST_MODELS };
const completions = buildModelArgumentCompletions(fakeModelRegistry);

describe("buildModelArgumentCompletions", () => {
	test("empty prefix lists every available model with provider/id values", () => {
		const items = completions("");
		expect(items).not.toBeNull();
		expect(items?.map(item => item.value)).toEqual([
			"anthropic/claude-opus-4-8",
			"cursor/composer-2.5-fast",
			"kimi-code/k3",
		]);
		for (const item of items ?? []) {
			const [provider, id] = item.value.split("/");
			const source = TEST_MODELS.find(m => m.provider === provider && m.id === id);
			expect(source).toBeDefined();
			expect(item.value).toBe(`${source?.provider}/${source?.id}`);
			expect(item.label).toBe(item.value);
			expect(item.description).toBe(source?.name);
		}
	});

	test("provider prefix narrows to matching models only", () => {
		const items = completions("cur");
		expect(items?.map(item => item.value)).toEqual(["cursor/composer-2.5-fast"]);
	});

	test("model id substring matches across providers", () => {
		const items = completions("opus");
		expect(items?.map(item => item.value)).toEqual(["anthropic/claude-opus-4-8"]);
	});

	test("startsWith matches rank before substring matches", () => {
		// "c" prefixes "cursor/…" but only occurs mid-string in
		// "anthropic/claude-…" and "kimi-code/…"; alphabetical order alone
		// would put anthropic first, so this order proves the ranking.
		const items = completions("c");
		expect(items?.map(item => item.value)).toEqual([
			"cursor/composer-2.5-fast",
			"anthropic/claude-opus-4-8",
			"kimi-code/k3",
		]);
	});

	test("leading @ is stripped before matching", () => {
		const items = completions("@kimi");
		expect(items?.map(item => item.value)).toEqual(["kimi-code/k3"]);
	});

	test("returns null once the model token is complete", () => {
		expect(completions("cursor/composer-2.5-fast ")).toBeNull();
	});
});
