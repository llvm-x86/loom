/**
 * What the parent is told after an isolated run.
 *
 * D1 (second half): a run whose changes cannot be captured must keep the
 *     isolation worktree, write a recovery note, and name the real cause —
 *     previously the worktree was deleted in `finally` and the parent saw
 *     "Merge failed" with no reason and no artifact.
 * D2 (surfacing): diverging gitignored paths are copied aside and named.
 * D3: `isolated: true` under `task.isolation.mode: "none"` must behave the same
 *     on the task tool as on the eval `agent()` bridge. The task tool's schema
 *     used to delete the key, so the shared preflight never saw it.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { mergeIsolatedChanges, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	resolveEffectiveSubagentPolicy,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
	type AgentDefinition,
	getTaskSchema,
	type SingleResult,
	type TaskParams,
} from "@oh-my-pi/pi-coding-agent/task/types";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as natives from "@oh-my-pi/pi-natives";
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
		settings: Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.isolation.mode": "none",
			...settings,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "task",
		agentSource: "bundled",
		task: "work",
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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("D1 — a capture failure keeps the work recoverable", () => {
	/**
	 * Drive a run whose subagent succeeds and whose capture then fails, with the
	 * isolation backend and the executor stubbed so the test owns the worktree.
	 * Branch mode reaches the same place through its own fallback: commit fails,
	 * then the patch capture behind it fails too.
	 */
	async function runWithFailingCapture(
		mergeMode: "patch" | "branch",
		root: string,
	): Promise<{ result: SingleResult; cleanupCalls: number }> {
		const isolationDir = path.join(root, "iso");
		const artifactsDir = path.join(root, "artifacts");
		await fs.mkdir(isolationDir, { recursive: true });
		await fs.mkdir(artifactsDir, { recursive: true });
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		const cleanup = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue(undefined);
		vi.spyOn(worktreeModule, "captureIgnoredChanges").mockResolvedValue({ changes: [], unscanned: [] });
		vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(new Error("git apply --3way failed"));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockRejectedValue(
			new Error("diff exceeded capture limit: 402653184 bytes (limit 268435456 bytes)"),
		);
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(singleResult());

		const result = await runIsolatedSubprocess({
			baseOptions: { id: "Worker" } as unknown as Parameters<typeof runIsolatedSubprocess>[0]["baseOptions"],
			context: {
				repoRoot: root,
				baseline: {
					root: {
						repoRoot: root,
						headCommit: "HEAD",
						staged: "",
						unstaged: "",
						untracked: [],
						untrackedPatch: "",
					},
					nested: [],
				},
			},
			preferredBackend: undefined,
			agentId: "Worker",
			mergeMode,
			artifactsDir,
			buildFailureResult: err => singleResult({ exitCode: 1, error: String(err) }),
		});
		return { result, cleanupCalls: cleanup.mock.calls.length };
	}

	it.each(["patch", "branch"] as const)(
		"writes a recovery note, keeps the worktree, and names the real cause (%s mode)",
		async mergeMode => {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-fail-")));
			const isolationDir = path.join(root, "iso");
			try {
				const { result, cleanupCalls } = await runWithFailingCapture(mergeMode, root);

				// The isolation worktree is the only copy of the work: it must survive.
				expect(cleanupCalls).toBe(0);
				expect(await fs.exists(isolationDir)).toBe(true);
				expect(result.captureFailure?.isolationDir).toBe(isolationDir);
				expect(result.captureFailure?.reason).toContain("diff exceeded capture limit");
				expect(result.error).toContain("diff exceeded capture limit");

				const notePath = result.captureFailure?.notePath ?? "";
				expect(notePath).toBe(path.join(root, "artifacts", "Worker.capture-failed.txt"));
				const note = await Bun.file(notePath).text();
				expect(note).toContain("diff exceeded capture limit");
				expect(note).toContain(isolationDir);

				// …and the parent is told, rather than being handed "no changes".
				const merge = await mergeIsolatedChanges({ result, repoRoot: root, mergeMode });
				expect(merge.changesApplied).toBe(false);
				expect(merge.summary).toContain(isolationDir);
				expect(merge.summary).toContain("diff exceeded capture limit");
				expect(merge.summary).not.toContain("No changes to apply");
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);
});

describe("D2 — diverging ignored paths reach the parent", () => {
	it("names each path, its status and the preserved copies", async () => {
		const result = singleResult({
			ignoredChanges: {
				changes: [
					{ relativePath: ".env", status: "modified", bytes: 12 },
					{ relativePath: "dist/app.js", status: "added", bytes: 6 },
				],
				unscanned: ["node_modules/"],
				preservedDir: "/artifacts/Worker.ignored",
				notPreserved: ["dist/huge.bin"],
			},
		});

		const merge = await mergeIsolatedChanges({ result, repoRoot: "/tmp", mergeMode: "patch" });
		expect(merge.summary).toContain(".env (modified)");
		expect(merge.summary).toContain("dist/app.js (added)");
		expect(merge.summary).toContain("/artifacts/Worker.ignored");
		expect(merge.summary).toContain("dist/huge.bin");
		expect(merge.summary).toContain("node_modules/");
		// The tracked-side verdict is whatever it would have been without the
		// ignored report — this only adds information.
		const control = await mergeIsolatedChanges({
			result: singleResult(),
			repoRoot: "/tmp",
			mergeMode: "patch",
		});
		expect(merge.changesApplied).toBe(control.changesApplied);
		expect(merge.hadAnyChanges).toBe(control.hadAnyChanges);
		expect(merge.summary.startsWith(control.summary)).toBe(true);
	});

	it("says nothing when no ignored path diverged", async () => {
		const merge = await mergeIsolatedChanges({ result: singleResult(), repoRoot: "/tmp", mergeMode: "patch" });
		expect(merge.summary).not.toContain("Gitignored");
	});

	it("preserves diverging ignored files beside the task artifacts", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-ignored-")));
		const isolationDir = path.join(root, "iso");
		const artifactsDir = path.join(root, "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		await Bun.write(path.join(isolationDir, ".env"), "TOKEN=agent\n");
		try {
			vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
				mergedDir: isolationDir,
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			});
			vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue(undefined);
			vi.spyOn(worktreeModule, "captureIgnoredChanges").mockResolvedValue({
				changes: [{ relativePath: ".env", status: "modified", bytes: 12 }],
				unscanned: [],
			});
			vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(singleResult());

			const result = await runIsolatedSubprocess({
				baseOptions: { id: "Worker" } as unknown as Parameters<typeof runIsolatedSubprocess>[0]["baseOptions"],
				context: {
					repoRoot: root,
					baseline: {
						root: {
							repoRoot: root,
							headCommit: "HEAD",
							staged: "",
							unstaged: "",
							untracked: [],
							untrackedPatch: "",
						},
						nested: [],
					},
				},
				preferredBackend: undefined,
				agentId: "Worker",
				mergeMode: "patch",
				artifactsDir,
				buildFailureResult: err => singleResult({ exitCode: 1, error: String(err) }),
			});

			expect(result.ignoredChanges?.changes).toEqual([{ relativePath: ".env", status: "modified", bytes: 12 }]);
			expect(result.ignoredChanges?.preservedDir).toBe(path.join(artifactsDir, "Worker.ignored"));
			expect(await Bun.file(path.join(artifactsDir, "Worker.ignored", ".env")).text()).toBe("TOKEN=agent\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("D3 — isolated:true means the same thing on both surfaces", () => {
	function evalBridgeRequest(session: ToolSession, requested: boolean): StructuredSubagentRequest {
		// Exactly what `runEvalAgent` builds for `agent(..., isolated=<requested>)`.
		return {
			session,
			invocationKind: "eval",
			assignment: "work",
			agent: "task",
			isolation: { requested },
		};
	}

	/**
	 * Validate through the tool's own wire schema before executing, exactly as
	 * the tool dispatcher does. Skipping this step is what let the stripped
	 * `isolated` key hide: `execute` never sees the raw call.
	 */
	function validated(tool: TaskTool, params: Record<string, unknown>): TaskParams {
		const parsed = tool.parameters(params);
		expect(parsed instanceof type.errors).toBe(false);
		return parsed as TaskParams;
	}

	it("keeps isolated in the task tool wire schema so preflight can see it", () => {
		const flat = getTaskSchema({ batchEnabled: false });
		expect(flat({ task: "check", isolated: true })).toEqual({ agent: "task", task: "check", isolated: true });

		const batch = getTaskSchema({ batchEnabled: true });
		expect(batch({ context: "ctx", tasks: [{ task: "check", isolated: true }] })).toEqual({
			context: "ctx",
			tasks: [{ agent: "task", task: "check", isolated: true }],
		});
	});

	it("rejects isolated:true under mode=none through the task tool", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(singleResult());

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tc", validated(tool, { task: "work", isolated: true }));

		expect(textOf(result)).toContain('task.isolation.mode to be set; current mode is "none"');
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects isolated:true under mode=none in the batch wire form too", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(singleResult());

		const tool = await TaskTool.create(createSession({ "task.batch": true }));
		const result = await tool.execute(
			"tc",
			validated(tool, { context: "ctx", tasks: [{ name: "Worker", task: "work", isolated: true }] }),
		);

		expect(textOf(result)).toContain('task.isolation.mode to be set; current mode is "none"');
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects the identical eval-bridge request, and accepts isolated:false on both", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const session = createSession();

		await expect(resolveEffectiveSubagentPolicy(evalBridgeRequest(session, true))).rejects.toThrow(
			'task.isolation.mode to be set; current mode is "none"',
		);

		const optedOut = await resolveEffectiveSubagentPolicy(evalBridgeRequest(session, false));
		expect(optedOut.isIsolated).toBe(false);

		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(singleResult());
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tc", validated(tool, { task: "work", isolated: false }));
		expect(textOf(result)).not.toContain("task.isolation.mode");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("rejects an explicit isolated on both surfaces in plan mode", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
		const planSession = createSession({ "task.isolation.mode": "auto" });
		planSession.getPlanModeState = () => ({ enabled: true, planFilePath: path.join(os.tmpdir(), "plan.md") });
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(singleResult());

		await expect(resolveEffectiveSubagentPolicy(evalBridgeRequest(planSession, true))).rejects.toThrow(
			"unavailable in plan mode",
		);

		const tool = await TaskTool.create(planSession);
		const result = await tool.execute("tc", validated(tool, { task: "work", isolated: true }));
		expect(textOf(result)).toContain("unavailable in plan mode");
		expect(run).not.toHaveBeenCalled();
	});
});
