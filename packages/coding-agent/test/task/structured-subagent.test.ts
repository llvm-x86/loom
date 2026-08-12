import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as planHandoff from "@oh-my-pi/pi-coding-agent/plan-mode/plan-handoff";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { IsolationContext } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as lockModule from "@oh-my-pi/pi-coding-agent/task/shared-tree-lock";
import {
	buildStructuredSubagentRecoveryHint,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { type AgentDefinition, getTaskSchema, type SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { $ } from "bun";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function session(
	options: {
		planMode?: boolean;
		outputSchema?: unknown;
		maxDepth?: number;
		isolationMode?: "none" | "auto" | "worktree" | "rcopy";
		isolationByDefault?: boolean;
		isolationRequired?: boolean;
		serializeSharedTree?: boolean;
		cwd?: string;
		repoRoot?: string;
	} = {},
): ToolSession {
	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings: Settings.isolated({
			"task.maxRecursionDepth": options.maxDepth ?? 2,
			"task.isolation.mode": options.isolationMode ?? "none",
			"task.isolation.byDefault": options.isolationByDefault ?? false,
			"task.isolation.required": options.isolationRequired ?? false,
			"task.isolation.serializeSharedTree": options.serializeSharedTree ?? false,
			"task.isolation.repoRoot": options.repoRoot ?? "",
			"task.enableLsp": true,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("structured subagent primitive", () => {
	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("gives task and eval invocations identical blocked-agent preflight errors", async () => {
		const previous = Bun.env.PI_BLOCKED_AGENT;
		Bun.env.PI_BLOCKED_AGENT = "worker";
		try {
			const discover = vi.spyOn(discoveryModule, "discoverAgents");
			const taskRequest = request();
			const evalRequest = request({ session: taskRequest.session, invocationKind: "eval" });
			const messages: string[] = [];
			for (const candidate of [taskRequest, evalRequest]) {
				try {
					await resolveEffectiveSubagentPolicy(candidate);
				} catch (error) {
					expect(error).toBeInstanceOf(StructuredSubagentError);
					messages.push((error as Error).message);
				}
			}
			expect(messages).toEqual([
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
				"Cannot spawn worker agent from within itself (recursion prevention). Use a different agent type.",
			]);
			expect(discover).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete Bun.env.PI_BLOCKED_AGENT;
			else Bun.env.PI_BLOCKED_AGENT = previous;
		}
	});

	it("attenuates plan-mode agents and rejects mutable isolation controls before discovery", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ planMode: true }), enableLsp: true, enableIrc: true }),
		);
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(policy.effectiveAgent.spawns).toBeUndefined();
		expect(policy.enableLsp).toBe(false);
		expect(policy.enableIrc).toBe(false);

		vi.restoreAllMocks();
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		await expect(
			resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true }), isolation: { requested: false } }),
			),
		).rejects.toThrow("isolation, apply, and merge controls are unavailable in plan mode");
		expect(discover).not.toHaveBeenCalled();
	});

	describe("task.isolation.byDefault", () => {
		it("isolates a spawn that sent no explicit flag", async () => {
			mockDiscovery();
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: session({ isolationMode: "auto", isolationByDefault: true }) }),
			);
			expect(policy.isIsolated).toBe(true);
		});

		it("lets an explicit isolated=false escape the default", async () => {
			mockDiscovery();
			const policy = await resolveEffectiveSubagentPolicy(
				request({
					session: session({ isolationMode: "auto", isolationByDefault: true }),
					isolation: { requested: false },
				}),
			);
			expect(policy.isIsolated).toBe(false);
		});

		it("stays non-isolated without throwing when the mode is none", async () => {
			mockDiscovery();
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: session({ isolationMode: "none", isolationByDefault: true }) }),
			);
			expect(policy.isIsolated).toBe(false);
		});

		it("never isolates a plan-mode spawn", async () => {
			mockDiscovery();
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true, isolationMode: "auto", isolationByDefault: true }) }),
			);
			expect(policy.isIsolated).toBe(false);
		});

		it("leaves spawns non-isolated when the setting is off", async () => {
			mockDiscovery();
			const policy = await resolveEffectiveSubagentPolicy(request({ session: session({ isolationMode: "auto" }) }));
			expect(policy.isIsolated).toBe(false);
		});
	});

	describe("task.isolation.required", () => {
		it("refuses an explicit isolated=false instead of honouring it", async () => {
			mockDiscovery();
			await expect(
				resolveEffectiveSubagentPolicy(
					request({
						session: session({ isolationMode: "auto", isolationRequired: true }),
						isolation: { requested: false },
					}),
				),
			).rejects.toThrow(/isolated: false. is refused/);
		});

		it("isolates a spawn that sent no flag even with byDefault off", async () => {
			mockDiscovery();
			const policy = await resolveEffectiveSubagentPolicy(
				request({
					session: session({ isolationMode: "auto", isolationByDefault: false, isolationRequired: true }),
				}),
			);
			expect(policy.isIsolated).toBe(true);
		});

		it("never blocks a plan-mode spawn, which is read-only and cannot isolate", async () => {
			mockDiscovery();
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: session({ planMode: true, isolationMode: "auto", isolationRequired: true }) }),
			);
			expect(policy.isIsolated).toBe(false);
		});

		it("cannot force isolation on when the backend mode is none", async () => {
			mockDiscovery();
			const policy = await resolveEffectiveSubagentPolicy(
				request({ session: session({ isolationMode: "none", isolationRequired: true }) }),
			);
			expect(policy.isIsolated).toBe(false);
		});

		it("still rejects an explicit isolated=true when the mode is none", async () => {
			mockDiscovery();
			await expect(
				resolveEffectiveSubagentPolicy(
					request({
						session: session({ isolationMode: "none", isolationByDefault: true }),
						isolation: { requested: true },
					}),
				),
			).rejects.toThrow('task.isolation.mode to be set; current mode is "none"');
		});

		it("keeps accepting an explicit isolated=false through the task tool schema", () => {
			const schema = getTaskSchema({ batchEnabled: false, defaultAgent: "task" });
			expect(schema({ task: "check", isolated: false })).toEqual({
				agent: "task",
				task: "check",
				isolated: false,
			});
		});

		it("runs the unchanged merge-back path for a default-isolated spawn", async () => {
			mockDiscovery();
			const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-default-isolation-"));
			let artifactsDir: string | undefined;
			try {
				const git = async (...args: string[]) => {
					const run = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
					if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
				};
				await git("init");
				await git("config", "user.email", "isolation@example.com");
				await git("config", "user.name", "Isolation");
				await Bun.write(path.join(repoRoot, "seed.txt"), "seed\n");
				await git("add", "seed.txt");
				await git("commit", "-m", "base");

				let worktree: string | undefined;
				vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
					worktree = options.worktree;
					await Bun.write(path.join(options.worktree ?? repoRoot, "seed.txt"), "edited by subagent\n");
					return result();
				});

				const settled = await runStructuredSubagent(
					request({ session: session({ cwd: repoRoot, isolationMode: "rcopy", isolationByDefault: true }) }),
				);
				artifactsDir = settled.artifactsDir;

				// The spawn never asked for isolation: the default put it in a
				// worktree, and the standard patch merge brought its edit home.
				expect(settled.policy.isIsolated).toBe(true);
				expect(worktree).toBeDefined();
				expect(worktree).not.toBe(repoRoot);
				expect(settled.changesApplied).toBe(true);
				expect(await Bun.file(path.join(repoRoot, "seed.txt")).text()).toBe("edited by subagent\n");
			} finally {
				await fs.rm(repoRoot, { recursive: true, force: true });
				if (artifactsDir) await fs.rm(artifactsDir, { recursive: true, force: true });
			}
		});
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("uses identical non-plan LSP and IRC policy for task and eval invocations", async () => {
		mockDiscovery();
		const taskPolicy = await resolveEffectiveSubagentPolicy(request());
		const evalPolicy = await resolveEffectiveSubagentPolicy(request({ invocationKind: "eval" }));

		expect(evalPolicy.enableLsp).toBe(taskPolicy.enableLsp);
		expect(evalPolicy.enableIrc).toBe(taskPolicy.enableIrc);
	});

	it("rejects an invalid caller schema before executor dispatch in both modes", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts when isolation setup fails without recovery", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));

		await expect(
			runStructuredSubagent(
				request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
			),
		).rejects.toThrow("Isolated subagent execution requires a git repository");
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("runs in place instead of failing when DEFAULTED isolation cannot be set up", async () => {
		// A default must never turn a spawn that would otherwise work into an
		// error. Outside a git repo there is nothing to make a worktree from, so
		// isolation-by-default degrades; only an explicit request fails loudly
		// (covered by the test above).
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));
		const ran = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationMode: "worktree", isolationByDefault: true, isolationRequired: true }),
			}),
		);

		expect(ran).toHaveBeenCalled();
		expect(settled.result.exitCode).toBe(0);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("resolves isolation from the spawn's cwd and the configured repo root", async () => {
		// The session sits in a container directory; the spawn names the checkout.
		mockDiscovery();
		const prepare = vi
			.spyOn(isolationRunner, "prepareIsolationContext")
			.mockRejectedValue(new Error("not a repository"));
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spawncwd-"));

		await expect(
			runStructuredSubagent(
				request({
					session: session({ isolationMode: "worktree", cwd: "/tmp", repoRoot: "checkout" }),
					isolation: { requested: true },
					cwd: dir,
				}),
			),
		).rejects.toThrow("Isolated subagent execution requires a git repository");

		expect(prepare).toHaveBeenCalledWith(dir, { configuredRoot: "checkout" });
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("rejects a spawn cwd that does not exist rather than falling back to the session cwd", async () => {
		mockDiscovery();
		await expect(
			runStructuredSubagent(request({ cwd: path.join(os.tmpdir(), "omp-missing-spawn-cwd") })),
		).rejects.toThrow("Spawn cwd is not an existing directory");
	});

	/** Isolation intended, but no repo to build a worktree from ⇒ degraded. */
	function degradedSession(overrides: Parameters<typeof session>[0] = {}) {
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));
		return session({ isolationMode: "worktree", isolationByDefault: true, serializeSharedTree: true, ...overrides });
	}

	it("REPORTS that it fell back to the parent's tree instead of degrading silently", async () => {
		// The original incident was invisible: a sibling's uncommitted file was
		// reverted and nothing failed — it surfaced only when an import broke.
		// Whatever the serialisation setting says, the parent is told.
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(
			request({ session: degradedSession({ serializeSharedTree: false }), retainArtifacts: true }),
		);

		expect(settled.mergeSummary).toContain("Isolation: UNAVAILABLE");
		expect(settled.mergeSummary).toContain("wrote directly to the parent's working tree");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("says nothing about isolation when a spawn was never meant to be isolated", async () => {
		mockDiscovery();
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationMode: "none" }), retainArtifacts: true }),
		);

		expect(settled.mergeSummary).toBe("");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("routes a DEGRADED write-capable spawn through the shared-tree lock", async () => {
		// Degradation is what makes this reachable: isolation was intended, could
		// not be set up, and the spawn now writes the parent's tree — the exact
		// incident isolation exists to prevent. If the boundary cannot hold in
		// space it holds in time. Lock SEMANTICS live in shared-tree-lock.test.ts;
		// this pins the wiring — which spawns queue, and on what key.
		mockDiscovery();
		const taken = vi.spyOn(lockModule, "withSharedTreeLock");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(
			request({ session: degradedSession({ cwd: "/tmp/shared-tree-a/." }), retainArtifacts: true }),
		);

		expect(taken).toHaveBeenCalledTimes(1);
		// Keyed by the RESOLVED path so "/x/." and "/x" are the same tree.
		expect(taken.mock.calls[0]?.[0]).toBe("/tmp/shared-tree-a");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("never queues a read-only subagent, even when degraded", async () => {
		// A scout cannot clobber anything, so queueing it would serialise the
		// most common fan-out for no safety gain.
		mockDiscovery({ ...AGENT, tools: ["read", "grep", "glob"] });
		const taken = vi.spyOn(lockModule, "withSharedTreeLock");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(request({ session: degradedSession(), retainArtifacts: true }));

		expect(taken).not.toHaveBeenCalled();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("never queues a spawn in a session that deliberately runs without isolation", async () => {
		// mode=none is an opt-in to a shared tree. Serialising it would be a
		// performance regression for existing fan-outs, not a safety win — the
		// hazard being fixed is isolation SILENTLY degrading, not isolation off.
		mockDiscovery();
		const taken = vi.spyOn(lockModule, "withSharedTreeLock");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(
			// Serialisation is ON, so not-degraded is the ONLY reason to skip it.
			request({
				session: session({ isolationMode: "none", serializeSharedTree: true }),
				retainArtifacts: true,
			}),
		);

		expect(taken).not.toHaveBeenCalled();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("never queues an ISOLATED spawn — it owns its worktree", async () => {
		mockDiscovery();
		const taken = vi.spyOn(lockModule, "withSharedTreeLock");
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({
			repoRoot: "/tmp/repo",
			baseline: undefined,
		} as unknown as IsolationContext);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationMode: "worktree", isolationByDefault: true }),
				retainArtifacts: true,
			}),
		);

		expect(taken).not.toHaveBeenCalled();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("leaves degraded spawns unserialised when the setting is off", async () => {
		mockDiscovery();
		const taken = vi.spyOn(lockModule, "withSharedTreeLock");
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const settled = await runStructuredSubagent(
			request({ session: degradedSession({ serializeSharedTree: false }), retainArtifacts: true }),
		);

		expect(taken).not.toHaveBeenCalled();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses plan capability sources while preserving non-plan propagation", async () => {
		mockDiscovery();
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const extensionPaths = ["/plugins/example.ts"];
		const customToolPaths = [{ path: "/tools/example.ts", source: "project" }] as unknown as NonNullable<
			ToolSession["customToolPaths"]
		>;
		const planSession = session({ planMode: true });
		Object.assign(planSession, { mcpManager, extensionPaths, customToolPaths });
		const nonPlanSession = session();
		Object.assign(nonPlanSession, { mcpManager, extensionPaths, customToolPaths });
		const mcpDisabledSession = session();
		mcpDisabledSession.enableMCP = false;
		const options = [] as executorModule.ExecutorOptions[];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const planRun = await runStructuredSubagent(request({ session: planSession, retainArtifacts: true }));
		const nonPlanRun = await runStructuredSubagent(request({ session: nonPlanSession, retainArtifacts: true }));
		const mcpDisabledRun = await runStructuredSubagent(
			request({ session: mcpDisabledSession, retainArtifacts: true }),
		);

		expect(options[0]).toMatchObject({
			enableMCP: false,
			restrictToolNames: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
		});
		expect(options[0]?.mcpManager).toBeUndefined();
		expect(options[1]).toMatchObject({
			enableMCP: true,
			mcpManager,
			preloadedExtensionPaths: extensionPaths,
			preloadedCustomToolPaths: customToolPaths,
		});
		expect(options[1]?.restrictToolNames).toBe(false);
		expect(options[2]).toMatchObject({ enableMCP: false });
		expect(options[2]?.mcpManager).toBeUndefined();
		await fs.rm(planRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(nonPlanRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(mcpDisabledRun.artifactsDir, { recursive: true, force: true });
	});

	it("unregisters and removes a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		failingSession.agentOutputManager = {
			allocate: async () => {
				throw new Error("allocate failed");
			},
		} as unknown as ToolSession["agentOutputManager"];
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("unregisters and removes a temporary lease when plan reference loading fails", async () => {
		mockDiscovery();
		vi.spyOn(planHandoff, "loadOverallPlanReference").mockRejectedValue(new Error("plan unavailable"));
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request())).rejects.toThrow("Subagent execution failed: plan unavailable");

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed nonisolated handle artifacts", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ invocationKind: "eval", retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("retains isolated failure artifacts needed for recovery", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		});

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
		);

		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});
