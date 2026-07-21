/**
 * Contracts: actionable guidance appended to a failed spawn's parent-facing
 * result text when the failure is a provider quota/rate-limit block.
 *
 * 1. A failure classified rate-limit (via `SingleResult.retryFailure`, the
 *    same structured signal the task renderer uses for its
 *    `⟦rate-limited⟧` chip, or a text match against known quota/rate-limit
 *    wording) gains a guidance block telling the parent not to retry the
 *    same model and to try a different provider, work inline, or wait.
 * 2. An ordinary failure (syntax error, plain non-zero exit) is untouched.
 * 3. The guidance is not duplicated if the same result is rendered twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { appendSpawnErrorGuidance, isRateLimitFailure } from "@oh-my-pi/pi-coding-agent/task/spawn-error-guidance";
import type { StructuredSubagentResult } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as structuredModule from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult, TaskParams } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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
		exitCode: 1,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

/** Mock the structured-subagent boundary to hand back a fixed result. */
function mockRunner(results: SingleResult[]): void {
	let i = 0;
	vi.spyOn(structuredModule, "runStructuredSubagent").mockImplementation(async () => {
		const result = results[Math.min(i, results.length - 1)];
		i += 1;
		return {
			result,
			policy: { discovery: { projectAgentsDir: null } },
			mergeSummary: undefined,
		} as unknown as StructuredSubagentResult;
	});
}

beforeEach(() => {
	mockDiscovery();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("spawn quota-block classification", () => {
	it("classifies via retryFailure regardless of error text", () => {
		expect(isRateLimitFailure(resultFor("a", { retryFailure: { attempt: 3, errorMessage: "gave up" } }))).toBe(true);
	});

	it("classifies via text match on error/stderr", () => {
		expect(isRateLimitFailure(resultFor("a", { error: "Connect error resource_exhausted: Error" }))).toBe(true);
		expect(isRateLimitFailure(resultFor("a", { stderr: "429 Too Many Requests" }))).toBe(true);
		expect(isRateLimitFailure(resultFor("a", { error: "usage limit reached" }))).toBe(true);
	});

	it("does not classify an ordinary failure", () => {
		expect(isRateLimitFailure(resultFor("a", { error: "SyntaxError: Unexpected token" }))).toBe(false);
		expect(isRateLimitFailure(resultFor("a", { error: "exit 1" }))).toBe(false);
	});
});

describe("spawn error guidance text", () => {
	it("appends guidance for a rate-limit-classified failure", () => {
		const result = resultFor("a", {
			error: "Connect error resource_exhausted: Error",
			resolvedModel: "anthropic/claude-haiku-4-5",
		});
		const text = appendSpawnErrorGuidance("base output", result);
		expect(text).toContain("Do NOT retry the same model");
		expect(text).toContain("tasks[]");
		expect(text).toContain("anthropic/claude-haiku-4-5");
	});

	it("leaves ordinary failure text untouched", () => {
		const result = resultFor("a", { error: "SyntaxError: Unexpected token" });
		const text = appendSpawnErrorGuidance("base output", result);
		expect(text).toBe("base output");
	});

	it("does not duplicate guidance when applied twice", () => {
		const result = resultFor("a", { error: "429 rate limit exceeded" });
		const once = appendSpawnErrorGuidance("base output", result);
		const twice = appendSpawnErrorGuidance(once, result);
		expect(twice).toBe(once);
		const occurrences = twice.split("Do NOT retry the same model").length - 1;
		expect(occurrences).toBe(1);
	});
});

describe("task tool result surface", () => {
	it("surfaces guidance in the tool result text for a quota-parked failure", async () => {
		mockRunner([
			resultFor("task", {
				exitCode: 1,
				error: "Connect error resource_exhausted: Error",
				retryFailure: { attempt: 2, errorMessage: "Connect error resource_exhausted: Error" },
			}),
		]);
		const tool = await TaskTool.create(createSession({ "task.batch": false }));
		const result = await tool.execute("call", { task: "Work." } as TaskParams);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("Do NOT retry the same model");
		expect(text).toContain("tasks[]");
	});

	it("does not add guidance for an ordinary failure result", async () => {
		mockRunner([resultFor("task", { exitCode: 1, error: "SyntaxError: Unexpected token", output: "boom" })]);
		const tool = await TaskTool.create(createSession({ "task.batch": false }));
		const result = await tool.execute("call", { task: "Work." } as TaskParams);
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).not.toContain("Do NOT retry the same model");
	});
});
