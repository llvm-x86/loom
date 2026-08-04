import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearScratch } from "@oh-my-pi/pi-coding-agent/cli/scratch-cli";
import { buildScratchToolEnv, ensureScratchDir } from "@oh-my-pi/pi-coding-agent/task/scratch";
import { getTaskIsolationSegment } from "@oh-my-pi/pi-coding-agent/task/worktree";
import {
	isPidAlive,
	readTaskIsolationOwner,
	SCRATCH_DEAD_OWNER_GRACE_MS,
	sweepOrphanedScratchDirs,
	TASK_ISOLATION_OWNER_FILE,
	type TaskIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/worktree-gc";
import { getScratchDir, prompt, setScratchDir } from "@oh-my-pi/pi-utils";
import projectPromptTemplate from "../src/prompts/system/project-prompt.md" with { type: "text" };
import subagentSystemPromptTemplate from "../src/prompts/system/subagent-system-prompt.md" with { type: "text" };

function writeOwner(baseDir: string, owner: TaskIsolationOwner): void {
	fs.writeFileSync(path.join(baseDir, TASK_ISOLATION_OWNER_FILE), JSON.stringify(owner), "utf8");
}

function makeOwner(pid: number): TaskIsolationOwner {
	return { pid, startedAt: new Date().toISOString(), repoRoot: "/tmp/repo", taskId: "task-1" };
}

// A pid that almost certainly does not exist. If it somehow does, probe
// downward until a genuinely dead one is found so assertions stay true.
function findDeadPid(): number {
	let pid = 4_194_303;
	while (pid > 1 && isPidAlive(pid)) pid -= 1;
	return pid;
}

function ageMs(baseDir: string, age: number): void {
	const when = new Date(Date.now() - age);
	fs.utimesSync(baseDir, when, when);
}

describe("task scratch dirs", () => {
	let tempRoot: string;
	let savedScratchDir: string | undefined;
	let savedWorktreeDir: string | undefined;
	let scratchRoot: string;

	beforeEach(() => {
		tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-task-scratch-gc-")));
		scratchRoot = path.join(tempRoot, "scratch");
		savedScratchDir = process.env.OMP_SCRATCH_DIR;
		savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
		// ensureScratchDir fires the once-per-process sweep of BOTH roots; keep
		// it pointed at temp dirs so tests never touch the real ~/.loom roots.
		process.env.OMP_SCRATCH_DIR = scratchRoot;
		process.env.OMP_WORKTREE_DIR = path.join(tempRoot, "wt");
	});

	afterEach(() => {
		setScratchDir(undefined);
		if (savedScratchDir === undefined) delete process.env.OMP_SCRATCH_DIR;
		else process.env.OMP_SCRATCH_DIR = savedScratchDir;
		if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	describe("ensureScratchDir", () => {
		it("creates a t-prefixed dir with tmp/ and a valid owner marker at task spawn", async () => {
			const dir = await ensureScratchDir(tempRoot, "task-1", "task");

			expect(dir).toBeDefined();
			expect(path.basename(dir!)).toMatch(/^t[0-9a-f]{9}$/);
			expect(dir).toBe(path.join(scratchRoot, path.basename(dir!)));
			expect(fs.statSync(path.join(dir!, "tmp")).isDirectory()).toBe(true);

			const owner = await readTaskIsolationOwner(dir!);
			expect(owner).not.toBeNull();
			expect(owner!.pid).toBe(process.pid);
			expect(owner!.taskId).toBe("task-1");
			// tempRoot is not a git checkout, so the cwd stands in for the repo root.
			expect(owner!.repoRoot).toBe(tempRoot);
		});

		it("creates an s-prefixed dir for an interactive session", async () => {
			const dir = await ensureScratchDir(tempRoot, "session-1", "session");

			expect(dir).toBeDefined();
			expect(path.basename(dir!)).toMatch(/^s[0-9a-f]{9}$/);
			const owner = await readTaskIsolationOwner(dir!);
			expect(owner!.taskId).toBe("session-1");
		});

		it("correlates a task scratch dir to its worktree by marker field, not by dir name", async () => {
			// The name used to be the worktree segment, i.e. a digest of
			// (repoRoot, taskId) only — which two same-named runs share. The
			// correlation moved into the marker so the name can stay unique.
			const dir = await ensureScratchDir(tempRoot, "task-1", "task");

			const owner = await readTaskIsolationOwner(dir!);
			expect(owner!.worktree).toBe(getTaskIsolationSegment(tempRoot, "task-1"));
			expect(path.basename(dir!)).not.toBe(getTaskIsolationSegment(tempRoot, "task-1"));
		});
	});

	describe("buildScratchToolEnv", () => {
		it("injects the run dir, the root, and TMPDIR when the redirect is on", () => {
			const env = buildScratchToolEnv("/scratch/tabc123", true);

			expect(env).toEqual({
				OMP_RUN_SCRATCH: "/scratch/tabc123",
				OMP_SCRATCH_DIR: scratchRoot,
				TMPDIR: "/scratch/tabc123/tmp",
			});
		});

		it("omits TMPDIR when the redirect kill switch is off", () => {
			const env = buildScratchToolEnv("/scratch/sdef456", false);

			expect(env).toEqual({ OMP_RUN_SCRATCH: "/scratch/sdef456", OMP_SCRATCH_DIR: scratchRoot });
		});

		it("never names the run's own dir as the root", () => {
			// One name for both meanings is what made a nested loom sweep the
			// running agent's own dir.
			const env = buildScratchToolEnv("/scratch/tabc123", true);

			expect(env?.OMP_SCRATCH_DIR).not.toBe("/scratch/tabc123");
		});

		it("returns undefined when the run has no scratch dir", () => {
			expect(buildScratchToolEnv(undefined, true)).toBeUndefined();
		});
	});

	describe("sweepOrphanedScratchDirs", () => {
		it("keeps a dir whose owner process is alive, however old", async () => {
			const live = path.join(scratchRoot, "tlive");
			fs.mkdirSync(live, { recursive: true });
			writeOwner(live, makeOwner(process.pid));
			ageMs(live, SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);

			const result = await sweepOrphanedScratchDirs();

			expect(result.failed).toEqual([]);
			expect(result.removed).toEqual([]);
			expect(fs.existsSync(live)).toBe(true);
		});

		it("keeps a dead-owner dir still inside the forensics grace window", async () => {
			const crashed = path.join(scratchRoot, "tcrashed");
			fs.mkdirSync(crashed, { recursive: true });
			writeOwner(crashed, makeOwner(findDeadPid()));

			const result = await sweepOrphanedScratchDirs();

			expect(result.failed).toEqual([]);
			expect(result.removed).toEqual([]);
			expect(fs.existsSync(crashed)).toBe(true);
		});

		it("sweeps a dead-owner dir older than the forensics grace window", async () => {
			const crashed = path.join(scratchRoot, "tcrashed");
			fs.mkdirSync(crashed, { recursive: true });
			writeOwner(crashed, makeOwner(findDeadPid()));
			ageMs(crashed, SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);

			const result = await sweepOrphanedScratchDirs();

			expect(result.failed).toEqual([]);
			expect(result.removed).toEqual([crashed]);
			expect(fs.existsSync(crashed)).toBe(false);
		});

		it("keeps a fresh marker-less dir and sweeps one past the legacy grace window", async () => {
			const freshLegacy = path.join(scratchRoot, "sfresh");
			fs.mkdirSync(freshLegacy, { recursive: true });
			const staleLegacy = path.join(scratchRoot, "sstale");
			fs.mkdirSync(staleLegacy, { recursive: true });
			ageMs(staleLegacy, SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);

			const result = await sweepOrphanedScratchDirs();

			expect(result.failed).toEqual([]);
			expect(result.removed).toEqual([staleLegacy]);
			expect(fs.existsSync(freshLegacy)).toBe(true);
			expect(fs.existsSync(staleLegacy)).toBe(false);
		});

		it("returns an empty result when the scratch root does not exist", async () => {
			const result = await sweepOrphanedScratchDirs();
			expect(result).toEqual({ removed: [], failed: [] });
		});

		it("never follows or removes a symlink at the scratch root", async () => {
			// The CLI used to fs.stat here (following the link), size the
			// TARGET, call it an orphaned legacy dir, and unlink it. The sweep
			// classifies from Dirent, so the two must agree: skip it.
			const precious = path.join(tempRoot, "precious");
			fs.mkdirSync(precious, { recursive: true });
			fs.writeFileSync(path.join(precious, "CANARY.txt"), "do not delete me", "utf8");
			const link = path.join(scratchRoot, "tsymlink");
			fs.mkdirSync(scratchRoot, { recursive: true });
			fs.symlinkSync(precious, link);
			ageMs(link, SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);

			const result = await sweepOrphanedScratchDirs();

			expect(result.removed).toEqual([]);
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.readFileSync(path.join(precious, "CANARY.txt"), "utf8")).toBe("do not delete me");
		});

		it("refuses to sweep a root that is itself a live run's dir", async () => {
			// Reached whenever a root variable ends up pointing at one run's own
			// dir: every child is then that run's work product, and the liveness
			// rule only ever guarded a root's children. The env var refuses a
			// marked root outright, so drive the root through `scratch.base` to
			// reach the sweep's own guard.
			fs.mkdirSync(scratchRoot, { recursive: true });
			writeOwner(scratchRoot, makeOwner(process.pid));
			setScratchDir(scratchRoot);
			expect(getScratchDir()).toBe(scratchRoot);
			const work = path.join(scratchRoot, "tmp");
			fs.mkdirSync(work, { recursive: true });
			fs.writeFileSync(path.join(work, "in-use.dat"), "live", "utf8");
			ageMs(work, SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);

			const result = await sweepOrphanedScratchDirs();

			expect(result.removed).toEqual([]);
			expect(fs.existsSync(path.join(work, "in-use.dat"))).toBe(true);
		});
	});

	describe("clearScratch", () => {
		it("never removes a live-owner dir, even with --all", async () => {
			const live = path.join(scratchRoot, "tlive");
			fs.mkdirSync(live, { recursive: true });
			writeOwner(live, makeOwner(process.pid));

			const staleDead = path.join(scratchRoot, "tstale");
			fs.mkdirSync(staleDead, { recursive: true });
			writeOwner(staleDead, makeOwner(findDeadPid()));

			await clearScratch({ all: true, dryRun: false, yes: true, json: true });

			expect(fs.existsSync(live)).toBe(true);
			// --all bypasses the grace window for dirs without a live owner.
			expect(fs.existsSync(staleDead)).toBe(false);
		});

		it("respects the grace window without --all", async () => {
			const staleDead = path.join(scratchRoot, "tstale");
			fs.mkdirSync(staleDead, { recursive: true });
			writeOwner(staleDead, makeOwner(findDeadPid()));
			ageMs(staleDead, SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);

			const freshDead = path.join(scratchRoot, "tfresh");
			fs.mkdirSync(freshDead, { recursive: true });
			writeOwner(freshDead, makeOwner(findDeadPid()));

			await clearScratch({ all: false, dryRun: false, yes: true, json: true });

			expect(fs.existsSync(staleDead)).toBe(false);
			expect(fs.existsSync(freshDead)).toBe(true);
		});
	});

	describe("prompt adoption", () => {
		it("renders the scratch block with the literal path in the subagent prompt", () => {
			const rendered = prompt.render(subagentSystemPromptTemplate, {
				agent: "test agent",
				scratch: "/home/u/.loom/scratch/tabc123",
			});

			expect(rendered).toContain("# Scratch Space");
			expect(rendered).toContain("`/home/u/.loom/scratch/tabc123`");
			expect(rendered).toContain("NEVER write scratch to /tmp");
		});

		it("omits the subagent scratch block when the run has no scratch dir", () => {
			const rendered = prompt.render(subagentSystemPromptTemplate, { agent: "test agent", scratch: "" });

			expect(rendered).not.toContain("# Scratch Space");
		});

		it("renders the scratch block in the interactive-session project prompt", () => {
			const rendered = prompt.render(projectPromptTemplate, {
				environment: [],
				contextFiles: [],
				scratch: "/home/u/.loom/scratch/sdef456",
			});

			expect(rendered).toContain("# Scratch Space");
			expect(rendered).toContain("`/home/u/.loom/scratch/sdef456`");
			expect(rendered).toContain("NEVER write scratch to /tmp");
		});

		it("omits the project-prompt scratch block for sessions without one", () => {
			const rendered = prompt.render(projectPromptTemplate, { environment: [], contextFiles: [], scratch: "" });

			expect(rendered).not.toContain("# Scratch Space");
		});
	});
});
