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
	const baseDir = TempDir.createSync("@pi-goal-show-bilevel-");
	const authStorage = await AuthStorage.create(path.join(baseDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected anthropic claude model in registry");
	return { authStorage, modelRegistry, model, baseDir };
}

async function createGoalHarness(shared: SharedFixture): Promise<GoalHarness> {
	resetSettingsForTest();
	const tempDir = TempDir.createSync("@pi-goal-show-bilevel-case-");
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

/** Drives search setup to create a bilevel goal with keep/keep model choices. */
async function createBilevelGoal(mode: InteractiveMode, objective = "Ship the release"): Promise<void> {
	vi.spyOn(mode, "showHookSelector").mockImplementation(async (title, options) => {
		const labels = optionLabels(options);
		if (title.startsWith("Goal search mode")) return labels[1]; // bilevel
		if (title.startsWith("Inner loop model")) return labels[0]; // keep current
		if (title.startsWith("Outer loop model")) return labels[0]; // keep/auto
		return undefined;
	});
	await mode.handleGoalModeCommand(objective);
	vi.restoreAllMocks();
}

describe("/goal show reports bilevel mode before the first inner iteration", () => {
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

	it("shows Bilevel immediately after setup, before state.bilevel is populated by the runtime", async () => {
		await createBilevelGoal(harness.mode);

		// Regression guard: `state.bilevel` (the runtime trace) is not populated until the first
		// inner-loop iteration closes via `GoalRuntime#runBilevelCycle`. A fresh bilevel goal has
		// no trace yet, but the setting is on — `/goal show` must still report Bilevel.
		expect(harness.settings.get("goal.bilevel.enabled")).toBe(true);
		expect(harness.session.getGoalModeState()?.bilevel).toBeUndefined();

		const showStatus = vi.spyOn(harness.mode, "showStatus");
		await harness.mode.handleGoalModeCommand("show");

		expect(showStatus).toHaveBeenCalledTimes(1);
		const message = showStatus.mock.calls[0]?.[0] as string;
		expect(message).toContain("Mode: Bilevel — cycle 0, iteration 0");
		expect(message).not.toContain("Mode: Standard");
	});

	it("shows Standard for a non-bilevel goal", async () => {
		vi.spyOn(harness.mode, "showHookSelector").mockImplementation(async (title, options) => {
			const labels = optionLabels(options);
			if (title.startsWith("Goal search mode")) return labels[0]; // standard
			return undefined;
		});
		await harness.mode.handleGoalModeCommand("Ship the release");
		vi.restoreAllMocks();

		const showStatus = vi.spyOn(harness.mode, "showStatus");
		await harness.mode.handleGoalModeCommand("show");

		const message = showStatus.mock.calls[0]?.[0] as string;
		expect(message).toContain("Mode: Standard");
	});

	it("surfaces the goal menu's View history… item once bilevel is enabled, even pre-trace", async () => {
		await createBilevelGoal(harness.mode);
		expect(harness.session.getGoalModeState()?.bilevel).toBeUndefined();

		const showHookSelector = vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue(undefined);
		await harness.mode.handleGoalModeCommand();

		const items = optionLabels(showHookSelector.mock.calls[0]?.[1] ?? []);
		expect(items).toContain("View history…");
	});

	it("View history… explains no trace exists yet instead of claiming the goal isn't bilevel", async () => {
		await createBilevelGoal(harness.mode);
		const showStatus = vi.spyOn(harness.mode, "showStatus");
		vi.spyOn(harness.mode, "showHookSelector").mockResolvedValue("View history…");

		await harness.mode.handleGoalModeCommand();

		expect(showStatus).toHaveBeenCalledWith(
			"No search history yet — bilevel history appears after the first inner-loop iteration.",
		);
	});
});
