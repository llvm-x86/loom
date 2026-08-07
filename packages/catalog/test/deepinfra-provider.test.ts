import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { deepinfraModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_ENV = {
	DEEPINFRA_TOKEN: Bun.env.DEEPINFRA_TOKEN,
	DEEPINFRA_API_KEY: Bun.env.DEEPINFRA_API_KEY,
} as const;

function restoreEnvVar(name: keyof typeof ORIGINAL_ENV): void {
	const value = ORIGINAL_ENV[name];
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

afterEach(() => {
	restoreEnvVar("DEEPINFRA_TOKEN");
	restoreEnvVar("DEEPINFRA_API_KEY");
	vi.restoreAllMocks();
});

describe("DeepInfra provider support", () => {
	test("resolves DEEPINFRA_TOKEN and DEEPINFRA_API_KEY env fallbacks", () => {
		Bun.env.DEEPINFRA_TOKEN = "deepinfra-token";
		expect(getEnvApiKey("deepinfra")).toBe("deepinfra-token");

		delete Bun.env.DEEPINFRA_TOKEN;
		Bun.env.DEEPINFRA_API_KEY = "deepinfra-api-key";
		expect(getEnvApiKey("deepinfra")).toBe("deepinfra-api-key");
	});

	test("registers descriptor, default model, bundled models, and login provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepinfra");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-ai/DeepSeek-V3");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["DEEPINFRA_TOKEN", "DEEPINFRA_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.deepinfra).toBe("deepseek-ai/DeepSeek-V3");

		const bundled = getBundledModels("deepinfra");
		expect(bundled.map(model => model.id).sort()).toEqual([
			"deepseek-ai/DeepSeek-V3",
			"deepseek-ai/DeepSeek-V4-Flash",
			"deepseek-ai/DeepSeek-V4-Flash-0731",
			"deepseek-ai/DeepSeek-V4-Pro",
		]);

		const v3 = bundled.find(model => model.id === "deepseek-ai/DeepSeek-V3");
		expect(v3?.api).toBe("openai-completions");
		expect(v3?.baseUrl).toBe("https://api.deepinfra.com/v1/openai");
		expect(v3?.reasoning).toBe(false);

		const flash = bundled.find(model => model.id === "deepseek-ai/DeepSeek-V4-Flash");
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		expect(flash?.compat?.requiresReasoningContentForToolCalls).toBe(true);

		const provider = getOAuthProviders().find(item => item.id === "deepinfra");
		expect(provider?.name).toBe("DeepInfra");
	});

	test("discovers models from DeepInfra /v1/openai/models with DeepSeek reasoning metadata", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "deepseek-ai/DeepSeek-V3" },
							{ id: "deepseek-ai/DeepSeek-V4-Flash" },
							{ id: "meta-llama/Llama-3.1-8B-Instruct" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as FetchImpl;

		const options = deepinfraModelManagerOptions({ apiKey: "deepinfra-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.deepinfra.com/v1/openai/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer deepinfra-key" }),
			}),
		);
		const flash = models?.find(model => model.id === "deepseek-ai/DeepSeek-V4-Flash");
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
	});
});
