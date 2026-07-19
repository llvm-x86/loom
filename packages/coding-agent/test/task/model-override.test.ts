/**
 * Contracts: per-invocation `model` override on the task tool.
 *
 * 1. All four wire schemas accept `model` as a non-empty string or non-empty
 *    string array; `"+": "delete"` preserves the declared key while still
 *    stripping unknown ones. Empty strings / arrays / non-string elements
 *    are rejected.
 * 2. The flat form carries a top-level `model` into the spawn; the batch
 *    form carries each item's own `model`, and a top-level `model` acts as
 *    the batch-wide default for items that do not set one.
 * 3. Precedence: item `model` > top-level `model` > agent frontmatter >
 *    `task.agentModelOverrides` setting (request.model ?? overrides, then
 *    frontmatter — ordering preserved from resolveEffectiveSubagentPolicy).
 * 4. Alias patterns (`@smol`) expand through settings; concrete patterns
 *    keep their `:<thinkingLevel>` suffix.
 * 5. `repairTaskParams` never touches `model` (identifier field, not prose).
 * 6. A resolved override surfaces as `SingleResult.modelOverride`; an absent
 *    override leaves results byte-identical to prior behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { repairTaskParams } from "@oh-my-pi/pi-coding-agent/task/repair-args";
import * as structuredModule from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
	resolveEffectiveSubagentPolicy,
	type StructuredSubagentResult,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type } from "arktype";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function createSession(settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "task.isolation.mode": "none", ...settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function mockDiscovery(agents: AgentDefinition[] = [taskAgent]): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
}

function resultFor(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

interface CapturedRequest {
	agent?: string;
	model?: string | string[];
}

/** Mock the structured-subagent boundary; return the captured requests. */
function mockRunner(results: SingleResult[] = []): CapturedRequest[] {
	const seen: CapturedRequest[] = [];
	vi.spyOn(structuredModule, "runStructuredSubagent").mockImplementation(async request => {
		seen.push({ agent: request.agent, model: request.model });
		const result = results[seen.length - 1] ?? resultFor(request.agent ?? "task");
		return {
			result,
			policy: { discovery: { projectAgentsDir: null } },
			mergeSummary: undefined,
		} as unknown as StructuredSubagentResult;
	});
	return seen;
}

beforeEach(() => {
	mockDiscovery();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("task model wire schemas", () => {
	const variants = [
		{ isolationEnabled: true, batchEnabled: true },
		{ isolationEnabled: false, batchEnabled: true },
		{ isolationEnabled: true, batchEnabled: false },
		{ isolationEnabled: false, batchEnabled: false },
	] as const;

	for (const variant of variants) {
		const label = `isolation=${variant.isolationEnabled} batch=${variant.batchEnabled}`;
		const schema = () => getTaskSchema(variant);

		it(`accepts a model string and string[] (${label})`, () => {
			const base = variant.batchEnabled
				? { context: "Shared.", tasks: [{ task: "Work.", model: "anthropic/claude-haiku-4-5" }] }
				: { task: "Work.", model: "anthropic/claude-haiku-4-5" };
			const parsed = schema()(base);
			expect(parsed instanceof type.errors).toBe(false);

			const chained = variant.batchEnabled
				? { context: "Shared.", tasks: [{ task: "Work.", model: ["a/x", "b/y:high"] }] }
				: { task: "Work.", model: ["a/x", "b/y:high"] };
			const parsedChain = schema()(chained);
			expect(parsedChain instanceof type.errors).toBe(false);
		});

		// Empty arrays pass arktype (`string>0[]` permits length 0, matching the
		// eval bridge); the runtime guard in validateSpawnParams rejects them.
		it(`rejects empty model values (${label})`, () => {
			for (const bad of ["", ["ok/model", ""], [42]]) {
				const input = variant.batchEnabled
					? { context: "Shared.", tasks: [{ task: "Work.", model: bad }] }
					: { task: "Work.", model: bad };
				expect(schema()(input) instanceof type.errors).toBe(true);
			}
		});
	}

	it("preserves model while stripping unknown keys", () => {
		const parsed = getTaskSchema({ isolationEnabled: true, batchEnabled: false })({
			task: "Work.",
			model: "@smol",
			bogus: "gone",
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect((parsed as { model?: unknown }).model).toBe("@smol");
			expect("bogus" in parsed).toBe(false);
		}
	});
});

describe("task model propagation", () => {
	it("passes a flat-form model to runStructuredSubagent", async () => {
		const seen = mockRunner();
		const tool = await TaskTool.create(createSession({ "task.batch": false }));
		await tool.execute("call", { task: "Work.", model: "moonshotai/kimi-k2-0905" } as TaskParams);
		expect(seen).toHaveLength(1);
		expect(seen[0].model).toBe("moonshotai/kimi-k2-0905");
	});

	it("passes each batch item's own model; siblings without one get undefined", async () => {
		const seen = mockRunner();
		const tool = await TaskTool.create(createSession({ "task.batch": true }));
		await tool.execute("call", {
			context: "Shared.",
			tasks: [
				{ name: "Pinned", task: "Work.", model: "anthropic/claude-haiku-4-5" },
				{ name: "Default", task: "Work." },
			],
		} as TaskParams);
		expect(seen).toHaveLength(2);
		expect(seen[0].model).toBe("anthropic/claude-haiku-4-5");
		expect(seen[1].model).toBeUndefined();
	});

	it("applies a top-level model to batch items without their own, and item model wins", async () => {
		const seen = mockRunner();
		const tool = await TaskTool.create(createSession({ "task.batch": true }));
		await tool.execute("call", {
			context: "Shared.",
			model: "openai/gpt-5.2",
			tasks: [
				{ name: "Pinned", task: "Work.", model: "@smol" },
				{ name: "Inherit", task: "Work." },
			],
		} as unknown as TaskParams);
		expect(seen).toHaveLength(2);
		expect(seen[0].model).toBe("@smol");
		expect(seen[1].model).toBe("openai/gpt-5.2");
	});

	it("rejects an invalid model value before spawning", async () => {
		const seen = mockRunner();
		const tool = await TaskTool.create(createSession({ "task.batch": false }));
		const result = await tool.execute("call", { task: "Work.", model: "  " } as TaskParams);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Invalid `model`");
		expect(seen).toHaveLength(0);
	});

	it("names the offending batch item for an invalid model", async () => {
		const seen = mockRunner();
		const tool = await TaskTool.create(createSession({ "task.batch": true }));
		const result = await tool.execute("call", {
			context: "Shared.",
			tasks: [
				{ name: "Good", task: "Work." },
				{ name: "Bad", task: "Work.", model: [] },
			],
		} as unknown as TaskParams);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Invalid `model`");
		expect(text).toContain("Bad");
		expect(seen).toHaveLength(0);
	});
});

describe("task model resolution precedence", () => {
	function preflight(request: { model?: string | string[] }, settings: Record<string, unknown> = {}) {
		return resolveEffectiveSubagentPolicy({
			session: createSession(settings),
			invocationKind: "task",
			assignment: "Work.",
			agent: "task",
			...request,
		});
	}

	it("request model beats task.agentModelOverrides", async () => {
		const policy = await preflight(
			{ model: "moonshotai/kimi-k2-0905" },
			{ "task.agentModelOverrides": { task: "openai/gpt-5.2" } },
		);
		expect(policy.modelOverride).toEqual(["moonshotai/kimi-k2-0905"]);
	});

	it("task.agentModelOverrides applies when no request model is given", async () => {
		const policy = await preflight({}, { "task.agentModelOverrides": { task: "openai/gpt-5.2" } });
		expect(policy.modelOverride).toEqual(["openai/gpt-5.2"]);
	});

	it("request model beats agent frontmatter model", async () => {
		vi.restoreAllMocks();
		mockDiscovery([{ ...taskAgent, model: ["anthropic/claude-haiku-4-5"] }]);
		const policy = await preflight({ model: "moonshotai/kimi-k2-0905" });
		expect(policy.modelOverride).toEqual(["moonshotai/kimi-k2-0905"]);
	});

	it("frontmatter model applies when no request model or override exists", async () => {
		vi.restoreAllMocks();
		mockDiscovery([{ ...taskAgent, model: ["anthropic/claude-haiku-4-5"] }]);
		const policy = await preflight({});
		expect(policy.modelOverride).toEqual(["anthropic/claude-haiku-4-5"]);
	});

	it("expands a @smol alias through settings", async () => {
		const policy = await preflight(
			{ model: "@smol" },
			{ modelRoles: { default: "openai/gpt-5.2", smol: "local/llama" } },
		);
		expect(policy.modelOverride).toEqual(["local/llama"]);
	});

	it("keeps a concrete pattern's thinking suffix intact", async () => {
		const policy = await preflight({ model: "anthropic/claude-sonnet-4-5:high" });
		expect(policy.modelOverride).toEqual(["anthropic/claude-sonnet-4-5:high"]);
	});

	it("keeps an ordered fallback chain in order", async () => {
		const policy = await preflight({ model: ["a/x:low", "b/y"] });
		expect(policy.modelOverride).toEqual(["a/x:low", "b/y"]);
	});
});

describe("task model repair safety", () => {
	it("leaves a model string containing escapes byte-identical", () => {
		const model = "provider/mod\\nel\\\\id:high";
		const repaired = repairTaskParams({ task: "Work.", model } as TaskParams);
		expect(repaired.model).toBe(model);
	});
});

describe("task model result surface", () => {
	it("surfaces a resolved override as SingleResult.modelOverride", async () => {
		mockRunner([resultFor("task", { modelOverride: ["moonshotai/kimi-k2-0905"] })]);
		const tool = await TaskTool.create(createSession({ "task.batch": false }));
		const result = await tool.execute("call", { task: "Work.", model: "moonshotai/kimi-k2-0905" } as TaskParams);
		expect(result.details?.results[0]?.modelOverride).toEqual(["moonshotai/kimi-k2-0905"]);
	});

	it("reports no modelOverride when model is absent", async () => {
		const seen = mockRunner();
		const tool = await TaskTool.create(createSession({ "task.batch": false }));
		const result = await tool.execute("call", { task: "Work." } as TaskParams);
		expect(seen[0].model).toBeUndefined();
		expect(result.details?.results[0]?.modelOverride).toBeUndefined();
	});
});
