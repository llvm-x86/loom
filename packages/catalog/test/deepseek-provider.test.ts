import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { deepseekModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("DeepSeek provider discovery", () => {
	const fetchWithModels = (ids: string[]): FetchImpl =>
		(async () =>
			new Response(
				JSON.stringify({
					data: ids.map(id => ({ id, object: "model" })),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as FetchImpl;

	test("advertises the unbundled vision-exp model as reasoning-capable with image input", async () => {
		const options = deepseekModelManagerOptions({
			apiKey: "deepseek-test-key",
			fetch: fetchWithModels(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]),
		});
		const models = await options.fetchDynamicModels?.();

		const vision = models?.find(model => model.id === "deepseek-v4-flash-vision-exp");
		expect(vision?.reasoning).toBe(true);
		expect(vision?.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] });
		expect(vision?.input).toEqual(["text", "image"]);
		expect(vision?.contextWindow).toBe(1_000_000);
		expect(vision?.maxTokens).toBe(384_000);
	});

	test("leaves bundled models' reasoning metadata intact", async () => {
		const options = deepseekModelManagerOptions({
			apiKey: "deepseek-test-key",
			fetch: fetchWithModels(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]),
		});
		const models = await options.fetchDynamicModels?.();

		const flash = models?.find(model => model.id === "deepseek-v4-flash");
		// Bundled deepseek-v4-flash is reasoning-native; the overlay must not
		// regress it and the curated thinking ladder must match.
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinking).toEqual({ mode: "effort", efforts: [Effort.Low, Effort.High, Effort.Max] });
	});
});
