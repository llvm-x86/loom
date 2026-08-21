import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	__resetResidentRegistrationForTesting,
	claimResidentOwnership,
	deleteResidentTranscript,
	isResidentForeignOwned,
	readResidentOwner,
	registerPersistedResidents,
	residentBankName,
	residentIdForAgent,
	residentsDirForSessionFile,
	residentTranscriptPath,
	routeToResident,
} from "@oh-my-pi/pi-coding-agent/task/resident";
import {
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A pid that is guaranteed dead: spawn a trivial process and wait for it to exit. */
function deadPid(): number {
	const proc = Bun.spawnSync(["true"]);
	return proc.pid;
}

describe("resident identity helpers", () => {
	it("derives stable PascalCase registry ids from agent names", () => {
		expect(residentIdForAgent("bug-reviewer")).toBe("BugReviewer");
		expect(residentIdForAgent("fix-architect")).toBe("FixArchitect");
	});

	it("derives stable per-persona bank names", () => {
		expect(residentBankName("bug-reviewer")).toBe("resident-bug-reviewer");
		expect(residentBankName("Fix Architect")).toBe("resident-fix-architect");
	});

	it("resolves the residents dir from the project session file only", () => {
		expect(residentsDirForSessionFile("/proj/sessions/abc.jsonl")).toBe(path.join("/proj/sessions", "residents"));
		expect(residentsDirForSessionFile(null)).toBeNull();
		expect(residentsDirForSessionFile("/proj/sessions/abc.txt")).toBeNull();
		expect(residentTranscriptPath("/proj/sessions/abc.jsonl", "BugReviewer")).toBe(
			path.join("/proj/sessions", "residents", "BugReviewer.jsonl"),
		);
		expect(residentTranscriptPath(null, "BugReviewer")).toBeNull();
	});
});

describe("resident ownership", () => {
	let tmp: TempDir;
	let transcript: string;

	beforeEach(async () => {
		tmp = TempDir.createSync("@pi-resident-");
		transcript = path.join(tmp.path(), "BugReviewer.jsonl");
		await Bun.write(transcript, "");
	});

	afterEach(() => {
		tmp[Symbol.dispose]();
	});

	it("claims an unowned transcript and recognizes its own claim", async () => {
		expect(await claimResidentOwnership(transcript)).toBe("claimed");
		expect(await claimResidentOwnership(transcript)).toBe("ours");
		const owner = await readResidentOwner(transcript);
		expect(owner?.pid).toBe(process.pid);
	});

	it("refuses a transcript owned by a live foreign process", async () => {
		await Bun.write(`${transcript}.owner`, JSON.stringify({ pid: 1, ts: Date.now() }));
		expect(await claimResidentOwnership(transcript)).toBe("foreign");
		expect(await isResidentForeignOwned(transcript)).toBe(true);
	});

	it("reclaims a transcript whose owner process is dead", async () => {
		await Bun.write(`${transcript}.owner`, JSON.stringify({ pid: deadPid(), ts: Date.now() - 60_000 }));
		expect(await claimResidentOwnership(transcript)).toBe("stale-reclaimed");
		expect((await readResidentOwner(transcript))?.pid).toBe(process.pid);
		expect(await isResidentForeignOwned(transcript)).toBe(false);
	});

	it("deleteResidentTranscript removes transcript and owner file", async () => {
		await claimResidentOwnership(transcript);
		expect(await deleteResidentTranscript(transcript)).toBe(true);
		expect(await fs.stat(transcript).catch(() => null)).toBeNull();
		expect(await readResidentOwner(transcript)).toBeNull();
		// Deleting again is a no-op, not an error.
		expect(await deleteResidentTranscript(transcript)).toBe(false);
	});
});

describe("registerPersistedResidents", () => {
	let tmp: TempDir;
	let sessionFile: string;

	beforeEach(async () => {
		tmp = TempDir.createSync("@pi-resident-");
		sessionFile = path.join(tmp.path(), "session.jsonl");
		await Bun.write(sessionFile, "");
		__resetResidentRegistrationForTesting();
	});

	afterEach(() => {
		tmp[Symbol.dispose]();
		__resetResidentRegistrationForTesting();
	});

	it("registers every persisted transcript as a parked ref, once", async () => {
		const dir = path.join(tmp.path(), "residents");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "BugReviewer.jsonl"), "");
		await Bun.write(path.join(dir, "FixArchitect.jsonl"), "");
		await Bun.write(path.join(dir, "BugReviewer.jsonl.owner"), "{}"); // not a transcript
		const registry = new AgentRegistry();

		await registerPersistedResidents(registry, sessionFile);
		const bug = registry.get("BugReviewer");
		expect(bug?.status).toBe("parked");
		expect(bug?.kind).toBe("sub");
		expect(bug?.sessionFile).toBe(path.join(dir, "BugReviewer.jsonl"));
		expect(registry.get("FixArchitect")?.status).toBe("parked");

		// Second scan is memoized per dir: no duplicate registration, no clobber.
		registry.setStatus("BugReviewer", "idle");
		await registerPersistedResidents(registry, sessionFile);
		expect(registry.get("BugReviewer")?.status).toBe("idle");
	});

	it("does not clobber an existing registry entry", async () => {
		const dir = path.join(tmp.path(), "residents");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "BugReviewer.jsonl"), "");
		const registry = new AgentRegistry();
		registry.register({
			id: "BugReviewer",
			displayName: "BugReviewer",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "running",
		});
		__resetResidentRegistrationForTesting();
		await registerPersistedResidents(registry, sessionFile);
		expect(registry.get("BugReviewer")?.status).toBe("running");
	});

	it("is a no-op for in-memory sessions and missing dirs", async () => {
		const registry = new AgentRegistry();
		await registerPersistedResidents(registry, null);
		await registerPersistedResidents(registry, path.join(tmp.path(), "nonexistent.jsonl"));
		expect(registry.list()).toHaveLength(0);
	});
});

describe("routeToResident", () => {
	let tmp: TempDir;
	let sessionFile: string;

	beforeEach(async () => {
		tmp = TempDir.createSync("@pi-resident-");
		sessionFile = path.join(tmp.path(), "session.jsonl");
		await Bun.write(sessionFile, "");
		__resetResidentRegistrationForTesting();
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(() => {
		tmp[Symbol.dispose]();
		__resetResidentRegistrationForTesting();
		AgentRegistry.resetGlobalForTests();
	});

	it("returns absent when no resident exists on disk or in the registry", async () => {
		const outcome = await routeToResident({
			registry: AgentRegistry.global(),
			id: "BugReviewer",
			task: "review the diff",
			sessionFile,
			timeoutMs: 50,
		});
		expect(outcome.kind).toBe("absent");
	});

	it("returns absent for aborted refs", async () => {
		// A foreign owner file beside the aborted ref's transcript proves the
		// guard short-circuits BEFORE the ownership check: without it the
		// outcome would be "foreign-owned", not "absent".
		const dir = path.join(tmp.path(), "residents");
		await fs.mkdir(dir, { recursive: true });
		const transcript = path.join(dir, "BugReviewer.jsonl");
		await Bun.write(transcript, "");
		await Bun.write(`${transcript}.owner`, JSON.stringify({ pid: 1, ts: Date.now() }));
		const registry = AgentRegistry.global();
		registry.register({
			id: "BugReviewer",
			displayName: "BugReviewer",
			kind: "sub",
			session: null,
			sessionFile: transcript,
			status: "aborted",
		});
		const outcome = await routeToResident({
			registry,
			id: "BugReviewer",
			task: "review the diff",
			sessionFile,
			timeoutMs: 50,
		});
		expect(outcome.kind).toBe("absent");
	});

	it("refuses to route to a resident owned by a live foreign process", async () => {
		const dir = path.join(tmp.path(), "residents");
		await fs.mkdir(dir, { recursive: true });
		const transcript = path.join(dir, "BugReviewer.jsonl");
		await Bun.write(transcript, "");
		await Bun.write(`${transcript}.owner`, JSON.stringify({ pid: 1, ts: Date.now() }));
		const outcome = await routeToResident({
			registry: AgentRegistry.global(),
			id: "BugReviewer",
			task: "review the diff",
			sessionFile,
			timeoutMs: 50,
		});
		expect(outcome.kind).toBe("foreign-owned");
	});

	it("routes to a parked resident registered from disk and fails over to absent when undeliverable", async () => {
		// A parked ref with no live session and no reviver installed: delivery
		// fails, and the router must degrade to "absent" (fresh spawn) rather
		// than strand the caller.
		const dir = path.join(tmp.path(), "residents");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "BugReviewer.jsonl"), "");
		const outcome = await routeToResident({
			registry: AgentRegistry.global(),
			id: "BugReviewer",
			task: "review the diff",
			sessionFile,
			timeoutMs: 200,
		});
		expect(outcome.kind).toBe("absent");
	});
});

describe("resident personas", () => {
	it("bug-reviewer and fix-architect are bundled, resident, and slow-model", () => {
		const bugReviewer = getBundledAgent("bug-reviewer");
		const fixArchitect = getBundledAgent("fix-architect");
		expect(bugReviewer?.resident).toBe(true);
		expect(fixArchitect?.resident).toBe(true);
		expect(bugReviewer?.model).toEqual(["@slow"]);
		expect(fixArchitect?.model).toEqual(["@slow"]);
		expect(bugReviewer?.systemPrompt).toContain("memory");
		expect(fixArchitect?.systemPrompt).toContain("memory");
	});
});

const RESIDENT_AGENT: AgentDefinition = {
	name: "bug-reviewer",
	description: "Test resident",
	systemPrompt: "Review things.",
	source: "bundled",
	tools: ["read", "grep"],
	resident: true,
};

function residentResult(): SingleResult {
	return {
		index: 0,
		id: "BugReviewer",
		agent: "bug-reviewer",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function residentSession(sessionFile: string | null): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.isolation.mode": "none",
			"task.isolation.byDefault": false,
			"task.isolation.required": false,
			"task.isolation.nonRepo": "workdir",
			"task.enableLsp": true,
		}),
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

describe("runStructuredSubagent resident path", () => {
	let tmp: TempDir;
	let sessionFile: string;

	beforeEach(async () => {
		tmp = TempDir.createSync("@pi-resident-spawn-");
		sessionFile = path.join(tmp.path(), "session.jsonl");
		await Bun.write(sessionFile, "");
		__resetResidentRegistrationForTesting();
		AgentRegistry.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [RESIDENT_AGENT],
			projectAgentsDir: null,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tmp[Symbol.dispose]();
		__resetResidentRegistrationForTesting();
		AgentRegistry.resetGlobalForTests();
	});

	function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
		return {
			session: residentSession(sessionFile),
			invocationKind: "task",
			assignment: "Review the new fix.",
			agent: "bug-reviewer",
			...overrides,
		};
	}

	it("fresh-spawns with stable id, pinned transcript, scoped bank, and claimed ownership", async () => {
		let captured: Parameters<typeof executorModule.runSubprocess>[0] | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = options;
			return residentResult();
		});

		const settled = await runStructuredSubagent(request());
		expect(settled.result.exitCode).toBe(0);
		expect(captured?.id).toBe("BugReviewer");
		expect(captured?.transcriptFile).toBe(path.join(tmp.path(), "residents", "BugReviewer.jsonl"));
		expect(captured?.settingsOverrides?.["mnemopi.bank"]).toBe("resident-bug-reviewer");
		const owner = await readResidentOwner(path.join(tmp.path(), "residents", "BugReviewer.jsonl"));
		expect(owner?.pid).toBe(process.pid);
	});

	it("skips isolation even when the caller defaults to it", async () => {
		// A REAL git repo: without the resident isolation bypass this spawn
		// would dispatch to runIsolatedSubprocess, not runSubprocess.
		const repoDir = path.join(tmp.path(), "repo");
		await fs.mkdir(repoDir, { recursive: true });
		Bun.spawnSync(["git", "init"], { cwd: repoDir });
		Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], {
			cwd: repoDir,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
		const sess = residentSession(sessionFile);
		sess.cwd = repoDir;
		sess.settings = Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.isolation.mode": "worktree",
			"task.isolation.byDefault": true,
			"task.isolation.required": true,
			"task.isolation.nonRepo": "error",
			"task.enableLsp": true,
		});
		const isolatedDispatch = vi.spyOn(isolationRunner, "runIsolatedSubprocess");
		let captured: Parameters<typeof executorModule.runSubprocess>[0] | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			captured = options;
			return residentResult();
		});
		const settled = await runStructuredSubagent(request({ session: sess }));
		expect(settled.result.exitCode).toBe(0);
		expect(captured?.id).toBe("BugReviewer");
		expect(isolatedDispatch).not.toHaveBeenCalled();
	});

	it("refuses to spawn when a live foreign process owns the resident", async () => {
		const dir = path.join(tmp.path(), "residents");
		await fs.mkdir(dir, { recursive: true });
		const transcript = path.join(dir, "BugReviewer.jsonl");
		await Bun.write(transcript, "");
		await Bun.write(`${transcript}.owner`, JSON.stringify({ pid: 1, ts: Date.now() }));
		const dispatch = vi.spyOn(executorModule, "runSubprocess");
		await expect(runStructuredSubagent(request())).rejects.toThrow(StructuredSubagentError);
		await expect(runStructuredSubagent(request())).rejects.toThrow(/owned by another live loom process/);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
