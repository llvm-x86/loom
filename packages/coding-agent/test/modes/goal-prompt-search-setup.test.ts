import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GoalTool } from "@oh-my-pi/pi-coding-agent/goals/tools/goal-tool";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

type SharedFixture = {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	model: Model;
	altModel: Model;
	baseDir: TempDir;
};

type GoalHarness = {
	tempDir: TempDir;
	settings: Settings;
	session: AgentSession;
	mode: InteractiveMode;
	cleanup: () => Promise<void>;
};

function createToolSession(cwd: string, settings: Settings, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		settings,
		...overrides,
	} as ToolSession;
}

async function createSharedFixture(): Promise<SharedFixture> {
	const baseDir = TempDir.createSync("@pi-goal-prompt-search-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	const altModel = modelRegistry.find("anthropic", "claude-opus-4-5");
	if (!model || !altModel) {
		throw new Error("Expected anthropic claude models in registry");
	}
	return { authStorage, modelRegistry, model, altModel, baseDir };
}

async function createGoalHarness(shared: SharedFixture): Promise<GoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-prompt-search-case-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	const { modelRegistry, model } = shared;

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"goal.enabled": true,
		"plan.enabled": true,
	});
	const bootstrapToolSession = createToolSession(tempDir.path(), settings);
	const initialTools = await createTools(bootstrapToolSession, ["read"]);
	const toolRegistry = new Map<string, Tool>(initialTools.map(tool => [tool.name, tool] as const));

	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: initialTools,
				messages: [],
			},
		}),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
	});
	const mode = new InteractiveMode(session, "test");
	const toolSession = createToolSession(tempDir.path(), settings, {
		getGoalModeState: () => session.getGoalModeState(),
		getGoalRuntime: () => session.goalRuntime,
		getTodoPhases: () => session.getTodoPhases(),
		setTodoPhases: phases => session.setTodoPhases(phases),
	});
	for (const tool of await createTools(toolSession, ["todo"])) {
		toolRegistry.set(tool.name, tool);
	}
	toolRegistry.set("goal", new GoalTool(toolSession) as unknown as Tool);

	return {
		tempDir,
		settings,
		session,
		mode,
		cleanup: async () => {
			mode.stop();
			await session.dispose();
			tempDir.removeSync();
			resetSettingsForTest();
		},
	};
}

function optionLabels(options: Parameters<InteractiveMode["showHookSelector"]>[1]): string[] {
	return options.map(option => (typeof option === "string" ? option : option.label));
}

describe("InteractiveMode goal search setup prompts", () => {
	let harness: GoalHarness;
	let shared: SharedFixture;

	beforeAll(async () => {
		initTheme();
		shared = await createSharedFixture();
	});

	afterAll(() => {
		shared.authStorage.close();
		shared.baseDir.removeSync();
	});

	beforeEach(async () => {
		harness = await createGoalHarness(shared);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.cleanup();
	});

	it("cancelling the mode selector writes nothing", async () => {
		const initialBilevel = harness.settings.get("goal.bilevel.enabled");
		const initialOuter = harness.settings.getModelRole("goalOuter");
		const initialModel = harness.session.model;
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue(undefined);

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(harness.settings.get("goal.bilevel.enabled")).toBe(initialBilevel);
		expect(harness.settings.getModelRole("goalOuter")).toBe(initialOuter);
		expect(harness.session.model).toBe(initialModel);
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});

	it("standard loop writes bilevel disabled and starts the goal", async () => {
		harness.settings.set("goal.bilevel.enabled", true);
		vi.spyOn(harness.mode, "showHookSelector").mockImplementation(async title =>
			title.startsWith("Goal search mode") ? "Standard goal loop" : undefined,
		);

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(harness.settings.get("goal.bilevel.enabled")).toBe(false);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
	});

	it("bilevel keep/keep enables bilevel without touching session model or goalOuter", async () => {
		const initialOuter = harness.settings.getModelRole("goalOuter");
		const initialModel = harness.session.model;
		vi.spyOn(harness.mode, "showHookSelector").mockImplementation(async (title, options) => {
			const labels = optionLabels(options);
			if (title.startsWith("Goal search mode")) return labels[1];
			if (title.startsWith("Inner loop model")) return labels[0];
			if (title.startsWith("Outer loop model")) return labels[0];
			return undefined;
		});

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(harness.settings.get("goal.bilevel.enabled")).toBe(true);
		expect(harness.settings.getModelRole("goalOuter")).toBe(initialOuter);
		expect(harness.session.model).toBe(initialModel);
		expect(harness.session.getGoalModeState()?.goal.objective).toBe("Ship the release");
	});

	it("bilevel searched inner model is session-only and does not write goalOuter", async () => {
		const altSelector = `${shared.altModel.provider}/${shared.altModel.id}`;
		const initialOuter = harness.settings.getModelRole("goalOuter");
		const setModelTemporary = vi.spyOn(harness.session, "setModelTemporary").mockResolvedValue(undefined);
		vi.spyOn(harness.mode, "pickModel").mockResolvedValue({ model: shared.altModel, selector: altSelector });
		vi.spyOn(harness.mode, "showHookSelector").mockImplementation(async (title, options) => {
			const labels = optionLabels(options);
			if (title.startsWith("Goal search mode")) return labels[1];
			if (title.startsWith("Inner loop model")) return "Search models…";
			if (title.startsWith("Outer loop model")) return labels[0];
			return undefined;
		});

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(setModelTemporary).toHaveBeenCalledTimes(1);
		expect(setModelTemporary).toHaveBeenCalledWith(
			shared.altModel,
			harness.session.resolveTemporaryModelThinkingLevel(shared.altModel),
		);
		expect(harness.settings.get("goal.bilevel.enabled")).toBe(true);
		expect(harness.settings.getModelRole("goalOuter")).toBe(initialOuter);
	});

	it("bilevel searched outer model persists goalOuter", async () => {
		const outerSelector = `${shared.altModel.provider}/${shared.altModel.id}:high`;
		vi.spyOn(harness.mode, "pickModel").mockResolvedValue({ model: shared.altModel, selector: outerSelector });
		vi.spyOn(harness.mode, "showHookSelector").mockImplementation(async (title, options) => {
			const labels = optionLabels(options);
			if (title.startsWith("Goal search mode")) return labels[1];
			if (title.startsWith("Inner loop model")) return labels[0];
			if (title.startsWith("Outer loop model")) return "Search models…";
			return undefined;
		});

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(harness.settings.get("goal.bilevel.enabled")).toBe(true);
		expect(harness.settings.getModelRole("goalOuter")).toBe(outerSelector);
	});

	it("escaping the searchable picker re-prompts and leaves settings untouched", async () => {
		const initialBilevel = harness.settings.get("goal.bilevel.enabled");
		const initialOuter = harness.settings.getModelRole("goalOuter");
		const pickModel = vi
			.spyOn(harness.mode, "pickModel")
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined);
		let innerPrompts = 0;
		vi.spyOn(harness.mode, "showHookSelector").mockImplementation(async (title, options) => {
			const labels = optionLabels(options);
			if (title.startsWith("Goal search mode")) return labels[1];
			if (title.startsWith("Inner loop model")) {
				innerPrompts += 1;
				return innerPrompts === 1 ? "Search models…" : undefined;
			}
			return undefined;
		});

		await harness.mode.handleGoalModeCommand("Ship the release");

		expect(innerPrompts).toBe(2);
		expect(pickModel).toHaveBeenCalledTimes(1);
		expect(harness.settings.get("goal.bilevel.enabled")).toBe(initialBilevel);
		expect(harness.settings.getModelRole("goalOuter")).toBe(initialOuter);
		expect(harness.session.getGoalModeState()).toBeUndefined();
	});
});
