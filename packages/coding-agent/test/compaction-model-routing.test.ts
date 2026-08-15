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

	function bundledKimiK3(): Model {
		const model = getBundledModel("kimi-code", "k3");
		if (!model) throw new Error("expected bundled kimi-code/k3 model");
		return model;
	}

	function bundledKimiK3_256k(): Model {
		const model = getBundledModel("kimi-code", "k3-256k");
		if (!model) throw new Error("expected bundled kimi-code/k3-256k model");
		return model;
	}

	function bundledCursorComposer(): Model {
		const model = getBundledModel("cursor", "composer-1");
		if (!model) throw new Error("expected bundled cursor/composer-1 model");
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

	it("falls through a quota-exhausted candidate to another enabled model", async () => {
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

		const dir = TempDir.createSync("@pi-compaction-routing-quota-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});
		const candidateProviders: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			candidateProviders.push(candidate.provider);
			if (candidateProviders.length === 1) {
				// Same shape the user hit: exhausted provider (cursor quota).
				throw new Error("Turn prefix summarization failed: Connect error resource_exhausted: Error");
			}
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
		session.settings.setModelRole("default", `${roleModel.provider}/${roleModel.id}`);

		try {
			await session.runIdleCompaction();
		} finally {
			await session.dispose();
		}

		// First candidate (exhausted) must not end the run; a later enabled
		// candidate is tried and completes the compaction.
		expect(candidateProviders.length).toBeGreaterThan(1);
		expect(candidateProviders[0]).toBe("openai");
	});

	/**
	 * `kimi-code/k3` declares `compactionModel: "k3-256k"`: the 262144-token
	 * sibling costs half the quota of the 1048576-token `k3`. When `k3` is the
	 * active chat model, compaction must try the cheap sibling first and only
	 * spend the full-price `k3` when the input actually overflows 256k.
	 */
	it("routes k3 compaction through the cheaper k3-256k sibling first", async () => {
		const modelRegistry = await makeRegistry(authStorage => {
			authStorage.setRuntimeApiKey("kimi-code", "test-kimi-key");
		});

		const dir = TempDir.createSync("@pi-compaction-routing-k3-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});
		const candidateIds: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			candidateIds.push(candidate.id);
			return {
				summary: "summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		const agent = new Agent({
			initialState: { model: bundledKimiK3(), systemPrompt: ["Test"], tools: [], messages: [] },
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

		try {
			await session.runIdleCompaction();
		} finally {
			await session.dispose();
		}

		expect(candidateIds.length).toBeGreaterThan(0);
		expect(candidateIds[0]).toBe("k3-256k");
	});

	it("falls back from k3-256k to k3 when the input overflows the 256k window", async () => {
		const modelRegistry = await makeRegistry(authStorage => {
			authStorage.setRuntimeApiKey("kimi-code", "test-kimi-key");
		});

		const dir = TempDir.createSync("@pi-compaction-routing-k3-overflow-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});
		const candidateIds: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			candidateIds.push(candidate.id);
			if (candidate.id === "k3-256k") {
				throw new Error(
					"This model's maximum context length is 262144 tokens, but the request exceeds the context window.",
				);
			}
			return {
				summary: "summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		const agent = new Agent({
			initialState: { model: bundledKimiK3(), systemPrompt: ["Test"], tools: [], messages: [] },
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

		try {
			await session.runIdleCompaction();
		} finally {
			await session.dispose();
		}

		expect(candidateIds).toEqual(["k3-256k", "k3"]);
	});

	it("uses k3-256k directly (no redirection needed) when it is already the active model", async () => {
		const modelRegistry = await makeRegistry(authStorage => {
			authStorage.setRuntimeApiKey("kimi-code", "test-kimi-key");
		});

		const candidateProviders: string[] = [];
		const dir = TempDir.createSync("@pi-compaction-routing-k3-256k-active-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});
		const candidateIds: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			candidateIds.push(candidate.id);
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
			initialState: { model: bundledKimiK3_256k(), systemPrompt: ["Test"], tools: [], messages: [] },
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

		try {
			await session.runIdleCompaction();
		} finally {
			await session.dispose();
		}

		expect(candidateIds[0]).toBe("k3-256k");
		expect(candidateProviders[0]).toBe("kimi-code");
	});

	/**
	 * Kimi compaction runs on substantially cheaper quota than routing a
	 * summary through whatever premium model is active for the turn. Unless
	 * the active model is itself a kimi-code model (or an explicit
	 * compactionModel override applies), compaction must default to the
	 * cheap kimi-code/k3-256k candidate ahead of the active model -- e.g. a
	 * cursor model -- even though cursor declares no compactionModel and the
	 * active-model candidate would otherwise be tried first.
	 */
	it("prefers kimi-code k3-256k over the active cursor model by default", async () => {
		const modelRegistry = await makeRegistry(authStorage => {
			authStorage.setRuntimeApiKey("kimi-code", "test-kimi-key");
			authStorage.setRuntimeApiKey("cursor", "test-cursor-key");
		});

		const dir = TempDir.createSync("@pi-compaction-routing-kimi-over-cursor-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});
		const candidateIds: string[] = [];
		const candidateProviders: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			candidateIds.push(candidate.id);
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
			initialState: { model: bundledCursorComposer(), systemPrompt: ["Test"], tools: [], messages: [] },
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

		try {
			await session.runIdleCompaction();
		} finally {
			await session.dispose();
		}

		expect(candidateIds[0]).toBe("k3-256k");
		expect(candidateProviders[0]).toBe("kimi-code");
		expect(candidateIds).not.toContain("composer-1");
	});

	it("falls back to k3 before the active cursor model when k3-256k overflows", async () => {
		const modelRegistry = await makeRegistry(authStorage => {
			authStorage.setRuntimeApiKey("kimi-code", "test-kimi-key");
			authStorage.setRuntimeApiKey("cursor", "test-cursor-key");
		});

		const dir = TempDir.createSync("@pi-compaction-routing-kimi-overflow-cursor-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});
		const candidateIds: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			candidateIds.push(candidate.id);
			if (candidate.id === "k3-256k") {
				throw new Error(
					"This model's maximum context length is 262144 tokens, but the request exceeds the context window.",
				);
			}
			return {
				summary: "summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		const agent = new Agent({
			initialState: { model: bundledCursorComposer(), systemPrompt: ["Test"], tools: [], messages: [] },
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

		try {
			await session.runIdleCompaction();
		} finally {
			await session.dispose();
		}

		expect(candidateIds).toEqual(["k3-256k", "k3"]);
	});

	it("falls back to the active cursor model when kimi-code isn't authenticated", async () => {
		const modelRegistry = await makeRegistry(authStorage => {
			authStorage.setRuntimeApiKey("cursor", "test-cursor-key");
		});

		const dir = TempDir.createSync("@pi-compaction-routing-cursor-no-kimi-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});
		const candidateIds: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, candidate) => {
			candidateIds.push(candidate.id);
			return {
				summary: "summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		const agent = new Agent({
			initialState: { model: bundledCursorComposer(), systemPrompt: ["Test"], tools: [], messages: [] },
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

		try {
			await session.runIdleCompaction();
		} finally {
			await session.dispose();
		}

		expect(candidateIds[0]).toBe("composer-1");
	});
});
