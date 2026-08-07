import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { makoraModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import type { Model } from "@oh-my-pi/pi-catalog";

const ORIGINAL_ENV = {
	MAKORA_API_KEY: Bun.env.MAKORA_API_KEY,
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
	restoreEnvVar("MAKORA_API_KEY");
	vi.restoreAllMocks();
});

describe("Makora provider support", () => {
	test("resolves MAKORA_API_KEY env fallback", () => {
		Bun.env.MAKORA_API_KEY = "makora-test-key";
		expect(getEnvApiKey("makora")).toBe("makora-test-key");
	});

	test("registers descriptor, default model, bundled models, and login provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "makora");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-ai/DeepSeek-V4-Flash");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["MAKORA_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.makora).toBe("deepseek-ai/DeepSeek-V4-Flash");

		const bundled = getBundledModels("makora");
		expect(bundled.map(model => model.id).sort()).toEqual([
			"deepseek-ai/DeepSeek-V4-Flash",
			"deepseek-ai/DeepSeek-V4-Pro",
		]);
		const flash = bundled.find(model => model.id === "deepseek-ai/DeepSeek-V4-Flash") as
			| Model<"openai-completions">
			| undefined;
		expect(flash?.api).toBe("openai-completions");
		expect(flash?.baseUrl).toBe("https://inference.makora.com/v1");
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
		expect(flash?.compat?.supportsReasoningEffort).toBe(true);

		const provider = getOAuthProviders().find(item => item.id === "makora");
		expect(provider?.name).toBe("Makora");
	});

	test("discovers models from Makora /v1/models with DeepSeek reasoning metadata", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "deepseek-ai/DeepSeek-V4-Flash" },
							{ id: "some-chat-model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as FetchImpl;

		const options = makoraModelManagerOptions({ apiKey: "makora-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://inference.makora.com/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer makora-key" }),
			}),
		);
		const flash = models?.find(model => model.id === "deepseek-ai/DeepSeek-V4-Flash");
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinking?.efforts).toEqual([Effort.High, Effort.Max]);
	});
});
