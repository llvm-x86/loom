import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The compaction summarizer must never route through the reverse-engineered
 * anthropic Claude Code OAuth framing (`sk-ant-oat` token / `isOAuth` model):
 * that request shape can't run a reliable local summary, so compaction has to
 * fall to any other enabled model. These tests exercise the observable routing
 * via the auto-compaction path (`runIdleCompaction` -> `compactionModule.compact`),
 * capturing the provider of the first summarizer candidate.
 */
describe("compaction model routing", () => {
	const tempDirs: TempDir[] = [];
	const stores: AuthStorage[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) store.close();
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	async function makeRegistry(configure: (authStorage: AuthStorage) => Promise<void> | void): Promise<ModelRegistry> {
		const dir = TempDir.createSync("@pi-compaction-routing-auth-");
		tempDirs.push(dir);
		const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		stores.push(authStorage);
		await configure(authStorage);
		return new ModelRegistry(authStorage);
	}

	function bundledAnthropic(): Model {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		return model;
	}

	async function firstCompactionCandidateProvider(
		modelRegistry: ModelRegistry,
		options: { roleModel?: Model } = {},
	): Promise<string[]> {
		const dir = TempDir.createSync("@pi-compaction-routing-case-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});

		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		const candidateProviders: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			candidateProviders.push(candidate.provider);
			return {
				summary: "summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		const agent = new Agent({
			initialState: { model: bundledAnthropic(), systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
			}),
			modelRegistry,
		});
		if (options.roleModel) {
			session.settings.setModelRole("default", `${options.roleModel.provider}/${options.roleModel.id}`);
		}

		try {
			await session.runIdleCompaction();
			return candidateProviders;
		} finally {
			await session.dispose();
		}
	}

	it("defers a reverse-engineered anthropic model, routing compaction to an enabled non-anthropic model", async () => {
		const modelRegistry = await makeRegistry(async authStorage => {
			await authStorage.set("anthropic", {
				type: "oauth",
				access: "sk-ant-oat-test-token",
				refresh: "refresh-token",
				expires: Date.now() + 3_600_000,
			});
			authStorage.setRuntimeApiKey("openai", "test-openai-key");
		});
		const roleModel = modelRegistry.getAvailable().find(model => model.provider === "openai");
		if (!roleModel) throw new Error("expected an available openai model");

		const candidateProviders = await firstCompactionCandidateProvider(modelRegistry, { roleModel });

		expect(candidateProviders.length).toBeGreaterThan(0);
		expect(candidateProviders[0]).not.toBe("anthropic");
		expect(candidateProviders[0]).toBe("openai");
	});

	it("keeps a non-OAuth (API-key) anthropic model as the first compaction candidate", async () => {
		const modelRegistry = await makeRegistry(authStorage => {
			// Plain API key, not the reverse-engineered `sk-ant-oat` OAuth framing.
			authStorage.setRuntimeApiKey("anthropic", "sk-ant-api-test-key");
			authStorage.setRuntimeApiKey("openai", "test-openai-key");
		});

		const candidateProviders = await firstCompactionCandidateProvider(modelRegistry);

		expect(candidateProviders.length).toBeGreaterThan(0);
		expect(candidateProviders[0]).toBe("anthropic");
	});
});
