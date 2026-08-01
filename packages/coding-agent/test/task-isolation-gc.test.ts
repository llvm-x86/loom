import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	classifyTaskIsolation,
	isPidAlive,
	readTaskIsolationOwner,
	sweepOrphanedTaskIsolations,
	TASK_ISOLATION_OWNER_FILE,
	TASK_ISOLATION_STALE_GRACE_MS,
	type TaskIsolationOwner,
} from "@oh-my-pi/pi-coding-agent/task/worktree-gc";

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

describe("task-isolation GC", () => {
	let tempRoot: string;
	let savedWorktreeDir: string | undefined;

	beforeEach(() => {
		tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-task-isolation-gc-")));
		savedWorktreeDir = process.env.OMP_WORKTREE_DIR;
	});

	afterEach(() => {
		if (savedWorktreeDir === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedWorktreeDir;
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	describe("readTaskIsolationOwner", () => {
		it("parses a valid owner marker", async () => {
			const baseDir = path.join(tempRoot, "tabc123");
			fs.mkdirSync(baseDir, { recursive: true });
			const owner = makeOwner(process.pid);
			writeOwner(baseDir, owner);

			expect(await readTaskIsolationOwner(baseDir)).toEqual(owner);
		});

		it("returns null for corrupt JSON", async () => {
			const baseDir = path.join(tempRoot, "tabc123");
			fs.mkdirSync(baseDir, { recursive: true });
			fs.writeFileSync(path.join(baseDir, TASK_ISOLATION_OWNER_FILE), "{ not json", "utf8");

			expect(await readTaskIsolationOwner(baseDir)).toBeNull();
		});

		it("returns null when the marker is missing", async () => {
			const baseDir = path.join(tempRoot, "tabc123");
			fs.mkdirSync(baseDir, { recursive: true });

			expect(await readTaskIsolationOwner(baseDir)).toBeNull();
		});

		it("returns null for a marker with the wrong shape", async () => {
			const baseDir = path.join(tempRoot, "tabc123");
			fs.mkdirSync(baseDir, { recursive: true });
			fs.writeFileSync(
				path.join(baseDir, TASK_ISOLATION_OWNER_FILE),
				JSON.stringify({ pid: "1234", startedAt: new Date().toISOString(), repoRoot: "/tmp/repo", taskId: "task-1" }),
				"utf8",
			);

			expect(await readTaskIsolationOwner(baseDir)).toBeNull();
		});
	});

	describe("isPidAlive", () => {
		it("reports the current process as alive", () => {
			expect(isPidAlive(process.pid)).toBe(true);
		});

		it("reports a nonexistent pid as dead", () => {
			const pid = 4_194_303;
			if (isPidAlive(pid)) return; // skip: pid somehow exists on this box
			expect(isPidAlive(pid)).toBe(false);
		});
	});

	describe("classifyTaskIsolation", () => {
		it("does not orphan a workspace whose owner process is alive", async () => {
			const baseDir = path.join(tempRoot, "tabc123");
			fs.mkdirSync(path.join(baseDir, "m"), { recursive: true });
			writeOwner(baseDir, makeOwner(process.pid));

			const result = await classifyTaskIsolation(baseDir);
			expect(result.orphaned).toBe(false);
			expect(result.owner?.pid).toBe(process.pid);
		});

		it("orphans a workspace whose owner process is gone", async () => {
			const baseDir = path.join(tempRoot, "tabc123");
			fs.mkdirSync(path.join(baseDir, "m"), { recursive: true });
			const deadPid = findDeadPid();
			const owner = makeOwner(deadPid);
			writeOwner(baseDir, owner);

			const result = await classifyTaskIsolation(baseDir);
			expect(result.orphaned).toBe(true);
			expect(result.orphanReason).toContain(String(deadPid));
			expect(result.owner).toEqual(owner);
		});

		it("does not orphan a fresh legacy workspace without a marker", async () => {
			const baseDir = path.join(tempRoot, "tabc123");
			fs.mkdirSync(path.join(baseDir, "m"), { recursive: true });

			const result = await classifyTaskIsolation(baseDir);
			expect(result.orphaned).toBe(false);
			expect(result.owner).toBeNull();
		});

		it("orphans a legacy workspace older than the stale grace window", async () => {
			const baseDir = path.join(tempRoot, "tabc123");
			fs.mkdirSync(path.join(baseDir, "m"), { recursive: true });
			const stale = new Date(Date.now() - TASK_ISOLATION_STALE_GRACE_MS - 60_000);
			fs.utimesSync(baseDir, stale, stale);

			const result = await classifyTaskIsolation(baseDir);
			expect(result.orphaned).toBe(true);
			expect(result.orphanReason).toContain("legacy");
			expect(result.owner).toBeNull();
		});
	});

	describe("sweepOrphanedTaskIsolations", () => {
		// Seam: getWorktreesDir() honors the OMP_WORKTREE_DIR env var, so the
		// sweep runs against a tmp root and never touches the real ~/.loom/wt.
		it("removes orphaned workspaces and keeps live ones", async () => {
			const wtRoot = path.join(tempRoot, "wt");
			process.env.OMP_WORKTREE_DIR = wtRoot;

			const orphaned = path.join(wtRoot, "torphan");
			fs.mkdirSync(path.join(orphaned, "m"), { recursive: true });
			writeOwner(orphaned, makeOwner(findDeadPid()));

			const live = path.join(wtRoot, "tlive");
			fs.mkdirSync(path.join(live, "m"), { recursive: true });
			writeOwner(live, makeOwner(process.pid));

			const freshLegacy = path.join(wtRoot, "tlegacy");
			fs.mkdirSync(path.join(freshLegacy, "merged"), { recursive: true });

			const unrelated = path.join(wtRoot, "prcheckout");
			fs.mkdirSync(unrelated, { recursive: true }); // no m/ or merged/ subdir

			const result = await sweepOrphanedTaskIsolations();

			expect(result.failed).toEqual([]);
			expect(result.removed).toEqual([orphaned]);
			expect(fs.existsSync(orphaned)).toBe(false);
			expect(fs.existsSync(live)).toBe(true);
			expect(fs.existsSync(freshLegacy)).toBe(true);
			expect(fs.existsSync(unrelated)).toBe(true);
		});

		it("returns an empty result when the worktrees root does not exist", async () => {
			process.env.OMP_WORKTREE_DIR = path.join(tempRoot, "wt-missing");

			const result = await sweepOrphanedTaskIsolations();
			expect(result).toEqual({ removed: [], failed: [] });
		});
	});
});
