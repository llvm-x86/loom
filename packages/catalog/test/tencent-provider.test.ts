import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { hostMatchesUrl } from "@oh-my-pi/pi-catalog/hosts";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { tencentModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_ENV = {
	TENCENT_API_KEY: Bun.env.TENCENT_API_KEY,
	TENCENT_BASE_URL: Bun.env.TENCENT_BASE_URL,
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
	restoreEnvVar("TENCENT_API_KEY");
	restoreEnvVar("TENCENT_BASE_URL");
	vi.restoreAllMocks();
});

// Bundled TokenHub gateway model ids. This list is not merely transcribed from Tencent's Model
// list doc (https://www.tencentcloud.com/document/product/1300/78934) — every id was validated
// against the live Singapore gateway, which distinguishes an unknown id (gateway error 400004,
// "model or service ID does not exist") from a known one, so ids the doc implies but the gateway
// rejects are excluded. See PRUNED_TENCENT_MODEL_IDS below.
const EXPECTED_TENCENT_MODEL_IDS = [
	"hy4-preview",
	"hy3",
	"hy-mt2-pro",
	"hy-mt2-plus",
	"hy-mt2-lite",
	"deepseek-v4-flash-202605",
	"deepseek-v4-pro-202606",
	"deepseek/deepseek-v4-flash-vision-exp",
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro-0813",
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"glm-5.3",
	"glm-5.3-flash",
	"glm-5.2",
	"glm-5.1",
	"glm-5v-turbo",
	"glm-5-turbo",
	"glm-5",
	"kimi-k3",
	"kimi-k2.7-code-highspeed",
	"kimi-k2.7-code",
	"kimi-k2.6",
	"minimax-m3",
	"minimax-m2.7",
	"mimo-v2.5-pro",
].sort();

// Ids that must NOT be bundled, each rejected with gateway error 400004 by the live endpoint:
//   - the four `deepseek/…`-prefixed spellings, which simply do not exist as service ids
//     (`deepseek/deepseek-v4-flash-vision-exp` is the one real slash-prefixed id);
//   - three models /v1/models still lists as status "pre-offline" but no longer serves.
const PRUNED_TENCENT_MODEL_IDS = [
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-flash-0731",
	"deepseek/deepseek-v4-pro",
	"deepseek/deepseek-v4-pro-0813",
	"deepseek-v3.2",
	"kimi-k2.5",
	"minimax-m2.5",
];

describe("Tencent Cloud (TokenHub) provider support", () => {
	test("resolves TENCENT_API_KEY env fallback", () => {
		Bun.env.TENCENT_API_KEY = "tencent-test-key";
		expect(getEnvApiKey("tencent")).toBe("tencent-test-key");
	});

	test("registers descriptor, default model, and login provider", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "tencent");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("hy4-preview");
		expect(descriptor?.catalogDiscovery?.envVars).toEqual(["TENCENT_API_KEY"]);
		expect(DEFAULT_MODEL_PER_PROVIDER.tencent).toBe("hy4-preview");

		const provider = getOAuthProviders().find(item => item.id === "tencent");
		expect(provider?.name).toBe("Tencent Cloud (TokenHub)");
	});

	test("bundles the full TokenHub catalog with verbatim wire ids", () => {
		// Wire-id round trip: every id TokenHub documents must be present exactly
		// once, with no gateway id missing and no invented/renamed id added.
		const bundled = getBundledModels("tencent");
		expect(bundled.map(model => model.id).sort()).toEqual(EXPECTED_TENCENT_MODEL_IDS);

		// Every bundled model must carry a real, positive input/output price —
		// this is a paid gateway, so a $0 entry would silently under-report cost.
		for (const model of bundled) {
			expect(model.cost.input, `${model.id} input cost`).toBeGreaterThan(0);
			expect(model.cost.output, `${model.id} output cost`).toBeGreaterThan(0);
			expect(model.cost.cacheWrite, `${model.id} cacheWrite`).toBe(0);
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("tencent");
		}

		// Gateway-rejected ids must stay out: bundling one puts an entry in the model picker that
		// can only ever fail at request time.
		const bundledIds = new Set(bundled.map(model => model.id));
		for (const id of PRUNED_TENCENT_MODEL_IDS) {
			expect(bundledIds.has(id), `${id} must not be bundled`).toBe(false);
		}
	});

	test("collapses DeepSeek's peak/off-peak schedule onto the PEAK price", () => {
		// Decision: ModelCost has no time-of-day tier, so a budget-ceiling-safe
		// bundle must round up to Tencent's PEAK rate (09:00-12:00/14:00-18:00
		// Beijing time) rather than off-peak or an average — a too-low price can
		// blow a budget mid-session, a too-high one only over-reports spend.
		const bundled = getBundledModels("tencent");
		const flashPeak = bundled.find(model => model.id === "deepseek-v4-flash");
		const proPeak = bundled.find(model => model.id === "deepseek-v4-pro");
		expect(flashPeak?.cost.input).toBe(0.14);
		expect(flashPeak?.cost.output).toBe(0.28);
		// The off-peak price (0.22/0.66 for the *GA vendor-direct* sibling) must
		// never leak into the peak-priced non-vendor id.
		expect(flashPeak?.cost.input).not.toBe(0.22);

		const flash0731 = bundled.find(model => model.id === "deepseek-v4-flash-0731");
		expect(flash0731?.cost.input).toBe(0.44); // peak, not the 0.22 off-peak rate
		expect(flash0731?.cost.output).toBe(1.32);
		expect(proPeak?.cost.input).toBe(1.74);
		expect(proPeak?.cost.output).toBe(3.48);
	});

	test("collapses MiniMax-M3's length-tiered schedule onto the <=512k tier", () => {
		// Decision: same budget-ceiling-safe rounding as DeepSeek peak pricing —
		// the >512k tier (0.6/2.4) is twice the <=512k tier (0.3/1.2), so bundling
		// the smaller (cheaper) tier keeps the *floor* of what a request can cost
		// visible, while the >512k requests still get billed correctly upstream.
		const bundled = getBundledModels("tencent");
		const m3 = bundled.find(model => model.id === "minimax-m3");
		expect(m3?.cost.input).toBe(0.3);
		expect(m3?.cost.output).toBe(1.2);
		expect(m3?.cost.input).not.toBe(0.6);
		// MiniMax-M3's max output is not documented anywhere in TokenHub's model list ("-"), so the
		// descriptor in openai-compat.ts passes `null` rather than guessing from a sibling model.
		// generate-models.ts then applies its standard fallback ceiling when bundling (the same
		// derivation every other provider gets for an undocumented output limit), so the bundled
		// spec resolves to 65536. Asserted against that real resolved value, not the raw `null`.
		expect(m3?.maxTokens).toBe(65_536);
		expect(m3?.contextWindow).toBe(1_048_576);
	});

	test("marks only guide-documented models as vision-capable", () => {
		const bundled = getBundledModels("tencent");
		const byId = new Map(bundled.map(model => [model.id, model]));
		const visionIds = [
			"deepseek/deepseek-v4-flash-vision-exp",
			"glm-5.3-flash",
			"glm-5v-turbo",
			"kimi-k3",
			"kimi-k2.7-code-highspeed",
			"kimi-k2.7-code",
			"kimi-k2.6",
		];
		for (const id of visionIds) {
			expect(byId.get(id)?.input, id).toContain("image");
		}
		// A text-only sibling from the same family must NOT inherit vision.
		expect(byId.get("glm-5.1")?.input).toEqual(["text"]);
		expect(byId.get("deepseek-v4-flash")?.input).toEqual(["text"]);
	});

	test("wires Hy-family reasoning_effort and kimi-k3's single-value effort dial", () => {
		const bundled = getBundledModels("tencent");
		const byId = new Map(bundled.map(model => [model.id, model]));

		const hy4 = byId.get("hy4-preview");
		const hy3 = byId.get("hy3");
		for (const model of [hy4, hy3]) {
			expect(model?.thinking?.mode).toBe("effort");
			expect(model?.thinking?.efforts).toContain(Effort.Low);
			expect(model?.thinking?.efforts).toContain(Effort.High);
		}

		// kimi-k3's own guide states reasoning_effort currently accepts only
		// "max" (also the default); the shared cross-provider identity layer
		// (model-thinking.ts's isKimiK3ModelId) normalizes every kimi-k3 model,
		// regardless of provider, onto the same low/high/max ladder with a
		// mandatory Max default — mirrors Moonshot's own bundled kimi-k3.
		const k3 = byId.get("kimi-k3");
		expect(k3?.thinking?.mode).toBe("effort");
		expect(k3?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(k3?.thinking?.requiresEffort).toBe(true);
		expect(k3?.thinking?.defaultLevel).toBe(Effort.Max);

		// Models with only a documented binary thinking.type toggle (no effort
		// ladder of their own) still carry `reasoning: true`; the shared
		// identity layer synthesizes a generic effort ladder for them (and
		// compat maps the picked effort back onto the wire toggle) — this
		// provider config never hand-authors a bespoke ladder for them.
		const glm53 = byId.get("glm-5.3");
		expect(glm53?.reasoning).toBe(true);
		expect(glm53?.thinking?.mode).toBe("effort");

		// The Hy-MT2 translation trio documents no reasoning capability at all.
		const mt2 = byId.get("hy-mt2-pro");
		expect(mt2?.reasoning).toBe(false);
		expect(mt2?.thinking).toBeUndefined();
	});

	test("resolves every regional TokenHub host, including the doc's dead .tech spelling", () => {
		// Keys are NOT interchangeable across sites (a wrong-site key -> 401002, verified live), so
		// each regional base URL must classify as the tencent host.
		const singapore = "https://tokenhub-intl.tencentcloudmaas.com/v1";
		const guangzhou = "https://tokenhub.tencentcloudmaas.com/v1";
		// The Silicon Valley host is `.com`; `.tech` (as printed in Tencent's overview doc) is
		// DNS-blackholed to 0.0.0.1 and never connects. Both must still classify, so that a URL
		// copied from either the doc or the console resolves to this provider rather than silently
		// falling through to no host match.
		const siliconValley = "https://tokenhub-us.tencentcloudmaas.com/v1";
		const siliconValleyDocTypo = "https://tokenhub-us.tencentcloudmaas.tech/v1";
		expect(hostMatchesUrl(singapore, "tencent")).toBe(true);
		expect(hostMatchesUrl(guangzhou, "tencent")).toBe(true);
		expect(hostMatchesUrl(siliconValley, "tencent")).toBe(true);
		expect(hostMatchesUrl(siliconValleyDocTypo, "tencent")).toBe(true);
		expect(hostMatchesUrl("https://api.openai.com/v1", "tencent")).toBe(false);
		expect(new Set([singapore, guangzhou, siliconValley]).size).toBe(3);
	});

	test("uses TENCENT_BASE_URL override for a non-default TokenHub host", async () => {
		// Must assert the override actually reaches the wire: `providerId` is identical with and
		// without the override, so asserting it alone proves nothing. The file-level afterEach
		// restores TENCENT_BASE_URL, so no manual cleanup is needed here.
		Bun.env.TENCENT_BASE_URL = "https://tokenhub.tencentcloudmaas.com/v1";
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "hy4-preview" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as FetchImpl;

		const options = tencentModelManagerOptions({ apiKey: "tencent-key", fetch: fetchMock });
		expect(options.providerId).toBe("tencent");
		await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://tokenhub.tencentcloudmaas.com/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
	});

	test("treats the Kimi guide's '>= 16000' max_tokens note as a floor, not an output ceiling", () => {
		// Regression guard: the guide recommends `max_tokens >= 16000` for k2.5/k2.6 (a suggested
		// floor for the shared reasoning+response quota). Encoding 16000 as `maxTokens` would cap a
		// 256K-context model at 16K of output. Every bundled 256K Kimi entry must agree. (k2.5 is
		// not bundled — the gateway no longer serves it.)
		const byId = new Map(getBundledModels("tencent").map(model => [model.id, model]));
		for (const id of ["kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"]) {
			expect(byId.get(id)?.contextWindow, id).toBe(256_000);
			expect(byId.get(id)?.maxTokens, id).toBe(256_000);
		}
		// kimi-k3 is the one Kimi model with an explicitly documented ceiling
		// (`max_completion_tokens` max = 1048576), so it is sourced, not inherited.
		expect(byId.get("kimi-k3")?.maxTokens).toBe(1_048_576);
	});

	test("discovers models from TokenHub /v1/models and preserves bundled metadata", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: [{ id: "hy4-preview" }, { id: "glm-5.3" }, { id: "some-other-model" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		) as unknown as FetchImpl;

		const options = tencentModelManagerOptions({ apiKey: "tencent-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://tokenhub-intl.tencentcloudmaas.com/v1/models",
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer tencent-key" }),
			}),
		);

		const hy4 = models?.find(model => model.id === "hy4-preview");
		expect(hy4?.reasoning).toBe(true);
		expect(hy4?.contextWindow).toBe(1_048_576);
		expect(hy4?.thinking?.efforts).toContain(Effort.High);

		const glm = models?.find(model => model.id === "glm-5.3");
		expect(glm?.reasoning).toBe(true);
		expect(glm?.cost.input).toBe(1.4);
		expect(glm?.contextWindow).toBe(1_048_576);
	});
});
