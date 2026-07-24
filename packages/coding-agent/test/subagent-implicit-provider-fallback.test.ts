import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

describe("subagent implicit cross-provider fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("synthesizes a chain to another credentialed provider when none is configured", async () => {
		const primary = model("cloud-a", "main");
		const other = model("cloud-b", "other");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "implicit-1",
			modelOverride: "cloud-a/main",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, other],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains?.["subagent:implicit-1"]).toEqual(["cloud-b/other"]);
	});

	it("prefers a role-configured model on the other provider over its flagship", async () => {
		const primary = model("cloud-a", "main");
		const cheap = model("cloud-b", "cheap");
		const pricey = model("cloud-b", "pricey");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const settings = Settings.isolated();
		settings.setModelRole("smol", "cloud-b/cheap");
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "implicit-2",
			modelOverride: "cloud-a/main",
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, cheap, pricey],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains?.["subagent:implicit-2"]).toEqual(["cloud-b/cheap"]);
	});

	it("does not synthesize a chain for an on-device primary", async () => {
		const primary = model("lm-studio", "local-reviewer");
		const other = model("cloud-b", "other");
		let childModelRole: string | undefined;
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModelRole = options.settings?.getModelRoles()["subagent:implicit-3"];
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "implicit-3",
			modelOverride: "lm-studio/local-reviewer",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, other],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModelRole).toBeUndefined();
		expect(childFallbackChains?.["subagent:implicit-3"]).toBeUndefined();
	});

	it("synthesizes nothing when the primary provider is the only one available", async () => {
		const primary = model("cloud-a", "main");
		let childModelRole: string | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModelRole = options.settings?.getModelRoles()["subagent:implicit-4"];
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "implicit-4",
			modelOverride: "cloud-a/main",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModelRole).toBeUndefined();
	});
});

describe("subagent parked-provider redirect at spawn", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Registry stub whose authStorage reports `parked` providers as fully blocked. */
	function registry(available: Model<Api>[], parked: Record<string, true>, blockedUntilMs: number) {
		return {
			refresh: async () => {},
			getAvailable: () => available,
			find: (provider: string, id: string) =>
				available.find(candidate => candidate.provider === provider && candidate.id === id),
			getApiKey: async () => "test-key",
			authStorage: {
				providerBlockedUntil: (provider: string) => (parked[provider] ? blockedUntilMs : undefined),
			},
		} as never;
	}

	it("reroutes to a healthy provider and tells the parent", async () => {
		const primary = model("cloud-a", "main");
		const other = model("cloud-b", "other");
		const blockedUntilMs = Date.now() + 3_600_000;
		let childModel: Model<Api> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			childModel = options?.model as Model<Api> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "parked-1",
			modelOverride: "cloud-a/main",
			settings: Settings.isolated(),
			modelRegistry: registry([primary, other], { "cloud-a": true }, blockedUntilMs),
			enableLsp: false,
		});

		expect(childModel?.provider).toBe("cloud-b");
		expect(result.modelRedirect).toEqual({ from: "cloud-a/main", to: "cloud-b/other", blockedUntilMs });
		expect(result.resolvedModel).toBe("cloud-b/other");
	});

	it("keeps the requested model when nothing is parked", async () => {
		const primary = model("cloud-a", "main");
		const other = model("cloud-b", "other");
		let childModel: Model<Api> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			childModel = options?.model as Model<Api> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "parked-2",
			modelOverride: "cloud-a/main",
			settings: Settings.isolated(),
			modelRegistry: registry([primary, other], {}, 0),
			enableLsp: false,
		});

		expect(childModel?.provider).toBe("cloud-a");
		expect(result.modelRedirect).toBeUndefined();
	});

	it("keeps the requested model when every alternative is also parked", async () => {
		const primary = model("cloud-a", "main");
		const other = model("cloud-b", "other");
		let childModel: Model<Api> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			childModel = options?.model as Model<Api> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "parked-3",
			modelOverride: "cloud-a/main",
			settings: Settings.isolated(),
			modelRegistry: registry([primary, other], { "cloud-a": true, "cloud-b": true }, Date.now() + 60_000),
			enableLsp: false,
		});

		expect(childModel?.provider).toBe("cloud-a");
		expect(result.modelRedirect).toBeUndefined();
	});
});
