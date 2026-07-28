/**
 * Retention contract for kept-alive subagents.
 *
 * A finished subagent is adopted by the {@link AgentLifecycleManager}, parked
 * after `task.agentIdleTtlMs`, and revived on demand. Parking is what releases
 * the run's memory, and revival is what keeps the agent addressable — the two
 * pull against each other, so both are pinned here:
 *
 * - parking must actually release the run (the reviver may not close over the
 *   SessionManager or AgentSession it rebuilds);
 * - a parked agent must stay reachable via `agent://<id>` and revive with its
 *   full history, so a follow-up (`hub send`, Agent Hub focus, `task resume`)
 *   still lands on the same conversation.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import * as modelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

const MOCK_API_SOURCE = "executor-subagent-retention-test";

/** A phrase the subagent emits on its first turn; must survive park → revive. */
const FIRST_TURN_MARKER = "sentinel-from-first-turn";

const agentDef: AgentDefinition = {
	name: "retainer",
	description: "retention contract agent",
	systemPrompt: "You are a retention test agent.",
	source: "bundled",
};

interface Harness {
	root: string;
	cwd: string;
	artifactsDir: string;
	auth: AuthStorage;
	settings: Settings;
	model: MockModel;
	/** Provider contexts observed per call, oldest first. */
	seenContexts: string[][];
}

let harness: Harness;

async function setup(): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-retention-"));
	const cwd = path.join(root, "work");
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(path.join(cwd, "README.md"), "# retention\n");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(artifactsDir, { recursive: true });
	// Stands in for the spawning session, whose registration is what puts the
	// shared artifacts dir on `agent://`'s search path in a real run.
	registerArtifactsDir(artifactsDir);

	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	auth.setRuntimeApiKey("mock", "test-key");

	const seenContexts: string[][] = [];
	let turn = 0;
	const model: MockModel = createMockModel({
		id: "retention-mock",
		handler: (context): MockResponse => {
			// The mock retains each call's Context; this suite asserts on
			// reachability, so keep only the text we compare against.
			model.calls.length = 0;
			seenContexts.push(
				context.messages.map(message =>
					typeof message.content === "string" ? message.content : JSON.stringify(message.content),
				),
			);
			turn++;
			if (turn === 1) return { content: [FIRST_TURN_MARKER] };
			return {
				content: [{ type: "toolCall", name: "yield", arguments: { result: { data: { turn } } } }],
			};
		},
	});

	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"task.maxRuntimeMs": 0,
		"task.softRequestBudget": 0,
		// Park is driven explicitly in these tests, never by the clock.
		"task.agentIdleTtlMs": 0,
	});

	spyOn(modelResolver, "resolveModelOverrideWithAuthFallback").mockImplementation(async () => {
		return {
			model: model as never,
			thinkingLevel: "off" as never,
			explicitThinkingLevel: false,
			authFallbackUsed: false,
		} as never;
	});

	return { root, cwd, artifactsDir, auth, settings, model, seenContexts };
}

async function spawnSubagent(id: string) {
	return runSubprocess({
		cwd: harness.cwd,
		agent: agentDef,
		task: "produce the sentinel and yield",
		assignment: "produce the sentinel and yield",
		index: 0,
		id,
		settings: harness.settings,
		authStorage: harness.auth,
		modelRegistry: new ModelRegistry(harness.auth, path.join(harness.root, "models.yml")),
		artifactsDir: harness.artifactsDir,
		sessionFile: path.join(harness.artifactsDir, "parent.jsonl"),
		persistArtifacts: true,
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		preloadedExtensionPaths: [],
		preloadedCustomToolPaths: [],
		keepAlive: true,
		parentAgentId: "Main",
	});
}

describe("kept-alive subagent retention", () => {
	beforeEach(async () => {
		registerMockApi(MOCK_API_SOURCE);
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		harness = await setup();
	});

	afterEach(async () => {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		unregisterCustomApis(MOCK_API_SOURCE);
		harness.auth.close();
		await fs.rm(harness.root, { recursive: true, force: true });
	});

	it("keeps a parked agent addressable and revives it with its full history", async () => {
		const id = "Retainer";
		const result = await spawnSubagent(id);
		expect(result.exitCode).toBe(0);

		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const beforePark = registry.get(id);
		expect(beforePark?.status).toBe("idle");
		const messagesBeforePark = beforePark?.session?.agent.state.messages.length ?? 0;
		expect(messagesBeforePark).toBeGreaterThan(0);

		await lifecycle.park(id);

		// Parked: the heavy session is gone, the identity and transcript are not.
		const parked = registry.get(id);
		expect(parked?.status).toBe("parked");
		expect(parked?.session).toBeNull();
		expect(parked?.sessionFile).toBe(path.join(harness.artifactsDir, `${id}.jsonl`));

		// agent://<id> reads the output artifact off disk, so it survives park.
		const resource = await new AgentProtocolHandler().resolve(parseInternalUrl(`agent://${id}`));
		expect(resource.content).toContain('"turn"');

		// Revival restores the same conversation, not an empty one.
		const revived = await lifecycle.ensureLive(id);
		expect(registry.get(id)?.status).toBe("idle");
		expect(revived.agent.state.messages.length).toBe(messagesBeforePark);
		expect(JSON.stringify(revived.agent.state.messages)).toContain(FIRST_TURN_MARKER);
	});

	it("delivers a follow-up turn to a parked agent on top of its earlier context", async () => {
		const id = "Followup";
		expect((await spawnSubagent(id)).exitCode).toBe(0);
		await AgentLifecycleManager.global().park(id);
		expect(AgentRegistry.global().get(id)?.session).toBeNull();

		harness.seenContexts.length = 0;
		const followUp = await runSubagentFollowUpTurn({
			id,
			agent: agentDef,
			message: "second question",
			artifactsDir: harness.artifactsDir,
		});

		expect(followUp.exitCode).toBe(0);
		// The revived turn saw the first turn's output, i.e. history was replayed
		// from the session file rather than starting a fresh conversation.
		const firstFollowUpContext = harness.seenContexts[0] ?? [];
		expect(firstFollowUpContext.join("\n")).toContain(FIRST_TURN_MARKER);
		expect(firstFollowUpContext.join("\n")).toContain("second question");
	});

	it("rebuilds a revived agent with the same identity, tools, prompt and model as the original run", async () => {
		const id = "Rebuilt";
		expect((await spawnSubagent(id)).exitCode).toBe(0);

		const original = AgentRegistry.global().get(id)?.session;
		expect(original).toBeDefined();
		const before = {
			manager: original?.sessionManager,
			tools: original?.getEnabledToolNames().slice().sort(),
			systemPrompt: original?.systemPrompt.join("\n"),
			model: original?.model?.id,
			cwd: original?.sessionManager.getCwd(),
		};
		expect(before.tools?.length).toBeGreaterThan(0);

		await AgentLifecycleManager.global().park(id);
		const revived = await AgentLifecycleManager.global().ensureLive(id);

		// Revival replays the session file through a *fresh* SessionManager; the
		// run's own journal is not reused (reusing it is what kept the finished
		// run resident). Everything the agent is made of must survive that
		// rebuild — a field dropped from the session template would silently
		// hand the user back a weaker agent under the same id.
		expect(revived.sessionManager).not.toBe(before.manager);
		expect(revived.getEnabledToolNames().slice().sort()).toEqual(before.tools ?? []);
		expect(revived.systemPrompt.join("\n")).toBe(before.systemPrompt ?? "");
		expect(revived.model?.id).toBe(before.model);
		expect(revived.sessionManager.getCwd()).toBe(before.cwd ?? "");
		expect(AgentRegistry.global().get(id)?.status).toBe("idle");
	});
});
