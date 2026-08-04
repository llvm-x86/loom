/**
 * Run-identity and root-safety regressions for per-run scratch dirs.
 *
 * Every case here reproduces a defect found by adversarial e2e against
 * PR #14's scratch implementation:
 *
 *   D1  `OMP_SCRATCH_DIR` meant both "scratch root" and "this run's dir", so a
 *       nested loom inside an agent's shell swept and cleared the live agent's
 *       own work product.
 *   D2  the dir name was a pure digest of `(repoRoot, taskId)` and a subagent's
 *       taskId is its NAME, so two same-named concurrent runs shared one dir.
 *   D2b a session's own `sync-context --resume` child re-claimed the marker and
 *       then died, leaving a live session's dir owned by a dead pid.
 *   D3  the CLI followed symlinks at the root while the sweep did not.
 *   D4  top-level sessions got no scratch tool env at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearScratch, listScratch } from "@oh-my-pi/pi-coding-agent/cli/scratch-cli";
import { assertScratchDir, buildScratchToolEnv, ensureScratchDir } from "@oh-my-pi/pi-coding-agent/task/scratch";
import { getTaskIsolationSegment } from "@oh-my-pi/pi-coding-agent/task/worktree";
import {
	isPidAlive,
	readTaskIsolationOwner,
	SCRATCH_DEAD_OWNER_GRACE_MS,
	sweepOrphanedScratchDirs,
	TASK_ISOLATION_OWNER_FILE,
} from "@oh-my-pi/pi-coding-agent/task/worktree-gc";
import { getScratchDir, setScratchDir } from "@oh-my-pi/pi-utils";

/** A pid that is alive but is not this process — the "foreign live owner" case. */
function spawnLivePid(): { pid: number; kill: () => void } {
	const child = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
	return { pid: child.pid, kill: () => child.kill("SIGKILL") };
}

function findDeadPid(): number {
	let pid = 4_194_303;
	while (pid > 1 && isPidAlive(pid)) pid -= 1;
	return pid;
}

function writeOwner(dir: string, owner: Record<string, unknown>): void {
	fs.writeFileSync(path.join(dir, TASK_ISOLATION_OWNER_FILE), JSON.stringify(owner), "utf8");
}

function ageMs(target: string, age: number): void {
	const when = new Date(Date.now() - age);
	fs.utimesSync(target, when, when);
}

/** Owner marker naming a process that is definitely gone. */
function makeDeadOwner(): Record<string, unknown> {
	return {
		pid: findDeadPid(),
		startedAt: "2026-08-01T00:00:00.000Z",
		repoRoot: "/tmp",
		taskId: "Old",
		runId: "r0",
		worktree: "tx",
	};
}

/** Capture everything the CLI prints for one call. */
async function captureOutput(run: () => Promise<void>): Promise<string> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		await run();
	} finally {
		console.log = original;
	}
	return lines.join("\n");
}

describe("scratch run identity", () => {
	let tempRoot: string;
	let scratchRoot: string;
	let fallbackRoot: string;
	let savedScratchDirEnv: string | undefined;
	let savedWorktreeDirEnv: string | undefined;

	beforeEach(() => {
		tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-scratch-identity-")));
		scratchRoot = path.join(tempRoot, "scratch");
		fs.mkdirSync(scratchRoot, { recursive: true });
		// Where root resolution must land when it rejects the env var. Pointing
		// the `scratch.base` override at a temp dir keeps every fallback inside
		// the fixture instead of the real ~/.loom/scratch.
		fallbackRoot = path.join(tempRoot, "fallback");
		fs.mkdirSync(fallbackRoot, { recursive: true });
		setScratchDir(fallbackRoot);
		savedScratchDirEnv = process.env.OMP_SCRATCH_DIR;
		savedWorktreeDirEnv = process.env.OMP_WORKTREE_DIR;
		process.env.OMP_SCRATCH_DIR = scratchRoot;
		// ensureScratchDir fires the once-per-process sweep of BOTH roots; keep
		// the worktree root in temp too so tests never touch the real ~/.loom.
		process.env.OMP_WORKTREE_DIR = path.join(tempRoot, "wt");
	});

	afterEach(() => {
		setScratchDir(undefined);
		if (savedScratchDirEnv === undefined) delete process.env.OMP_SCRATCH_DIR;
		else process.env.OMP_SCRATCH_DIR = savedScratchDirEnv;
		if (savedWorktreeDirEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedWorktreeDirEnv;
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	/**
	 * Build the state a live agent's own scratch dir is in: an owner marker
	 * naming a live process, a `tmp/` redirect target, and work product.
	 */
	function makeLiveRunDir(pid: number, name = "trun"): string {
		const runDir = path.join(tempRoot, name);
		fs.mkdirSync(path.join(runDir, "tmp"), { recursive: true });
		fs.writeFileSync(path.join(runDir, "tmp", "agent-tempfile.dat"), "in use", "utf8");
		fs.mkdirSync(path.join(runDir, "analysis"), { recursive: true });
		fs.writeFileSync(path.join(runDir, "analysis", "results.json"), "{}", "utf8");
		writeOwner(runDir, {
			pid,
			startedAt: new Date().toISOString(),
			repoRoot: tempRoot,
			taskId: "Agent",
			runId: "run-1",
			worktree: "tdeadbeef",
		});
		return runDir;
	}

	describe("D1 — a run dir is never a scratch root", () => {
		it("ignores an OMP_SCRATCH_DIR that names a run's own dir", () => {
			const live = spawnLivePid();
			try {
				const runDir = makeLiveRunDir(live.pid);
				process.env.OMP_SCRATCH_DIR = runDir;

				// A nested loom inherits the variable; it must not adopt the
				// agent's dir as the root that GC operates on.
				expect(getScratchDir()).toBe(fallbackRoot);
				expect(getScratchDir().startsWith(runDir)).toBe(false);
			} finally {
				live.kill();
			}
		});

		it("still honours an OMP_SCRATCH_DIR that names a real root", () => {
			// The rejection must be narrow: an ordinary root has no owner marker.
			expect(getScratchDir()).toBe(scratchRoot);
		});

		it("does not sweep a live agent's tmp/ when a nested loom inherits its dir", async () => {
			const live = spawnLivePid();
			try {
				const runDir = makeLiveRunDir(live.pid);
				// Aged past the legacy grace: the exact state that made merely
				// STARTING a nested loom delete the live agent's TMPDIR target.
				ageMs(path.join(runDir, "tmp"), SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);
				ageMs(path.join(runDir, "analysis"), SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);
				process.env.OMP_SCRATCH_DIR = runDir;

				const result = await sweepOrphanedScratchDirs();

				expect(result.removed).toEqual([]);
				expect(fs.existsSync(path.join(runDir, "tmp", "agent-tempfile.dat"))).toBe(true);
				expect(fs.existsSync(path.join(runDir, "analysis", "results.json"))).toBe(true);
			} finally {
				live.kill();
			}
		});

		it("does not let clear --all delete a live agent's work product through the inherited var", async () => {
			const live = spawnLivePid();
			try {
				const runDir = makeLiveRunDir(live.pid);
				process.env.OMP_SCRATCH_DIR = runDir;

				await captureOutput(() => clearScratch({ all: true, dryRun: false, yes: true, json: true }));

				// `--all` waives every grace window, so nothing but the root
				// check stands between it and the agent's live subdirectories.
				expect(fs.existsSync(path.join(runDir, "tmp", "agent-tempfile.dat"))).toBe(true);
				expect(fs.existsSync(path.join(runDir, "analysis", "results.json"))).toBe(true);
			} finally {
				live.kill();
			}
		});

		it("refuses to sweep or clear a live-owner root reached without the env var", async () => {
			const live = spawnLivePid();
			try {
				const runDir = makeLiveRunDir(live.pid);
				// Second line of defence: the root resolved from `scratch.base`,
				// which getScratchDir deliberately does not second-guess.
				delete process.env.OMP_SCRATCH_DIR;
				setScratchDir(runDir);
				expect(getScratchDir()).toBe(runDir);
				ageMs(path.join(runDir, "tmp"), SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);

				const swept = await sweepOrphanedScratchDirs();
				const output = await captureOutput(() => clearScratch({ all: true, dryRun: false, yes: true, json: true }));

				expect(swept.removed).toEqual([]);
				expect(output).toContain("refus");
				expect(fs.existsSync(path.join(runDir, "tmp", "agent-tempfile.dat"))).toBe(true);
				expect(fs.existsSync(path.join(runDir, "analysis", "results.json"))).toBe(true);
			} finally {
				live.kill();
			}
		});
	});

	describe("D2 — two runs never share a dir", () => {
		it("gives concurrent same-named tasks in one repo different dirs", async () => {
			const first = await ensureScratchDir(tempRoot, "Twin", "task");
			const second = await ensureScratchDir(tempRoot, "Twin", "task");

			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(second).not.toBe(first);
			expect(fs.existsSync(path.join(first!, "tmp"))).toBe(true);
			expect(fs.existsSync(path.join(second!, "tmp"))).toBe(true);

			// Each dir records its own run, so neither can be mistaken for the
			// other's leftover.
			const firstOwner = await readTaskIsolationOwner(first!);
			const secondOwner = await readTaskIsolationOwner(second!);
			expect(firstOwner!.taskId).toBe("Twin");
			expect(secondOwner!.taskId).toBe("Twin");
			expect(firstOwner!.runId).toBeDefined();
			expect(secondOwner!.runId).not.toBe(firstOwner!.runId);
		});

		it("keeps the worktree correlation as a marker field, not as the dir name", async () => {
			const dir = await ensureScratchDir(tempRoot, "task-1", "task");
			const owner = await readTaskIsolationOwner(dir!);

			const worktreeSegment = getTaskIsolationSegment(tempRoot, "task-1");
			expect(owner!.worktree).toBe(worktreeSegment);
			// The name-level correlation is what caused the collision; it is
			// deliberately gone.
			expect(path.basename(dir!)).not.toBe(worktreeSegment);
			expect(path.basename(dir!)).toMatch(/^t[0-9a-f]{9}$/);
		});

		it("keeps one session's dir stable across resumes", async () => {
			const first = await ensureScratchDir(tempRoot, "session-abc", "session");
			const second = await ensureScratchDir(tempRoot, "session-abc", "session");

			expect(second).toBe(first);
			expect(path.basename(first!)).toMatch(/^s[0-9a-f]{9}$/);
		});
	});

	describe("D2b — a live owner marker is never stolen", () => {
		it("leaves a live foreign owner in place when the same session is re-entered", async () => {
			const live = spawnLivePid();
			try {
				const dir = await ensureScratchDir(tempRoot, "session-xyz", "session");
				const claimed = await readTaskIsolationOwner(dir!);
				// Stand in for the still-running parent session: a helper such as
				// `sync-context --resume` re-derives this exact dir.
				writeOwner(dir!, { ...claimed, pid: live.pid });

				const again = await ensureScratchDir(tempRoot, "session-xyz", "session");

				expect(again).toBe(dir);
				const owner = await readTaskIsolationOwner(dir!);
				expect(owner!.pid).toBe(live.pid);
				expect(owner!.pid).not.toBe(process.pid);
			} finally {
				live.kill();
			}
		});

		it("re-claims a dir whose recorded owner is dead", async () => {
			const dir = await ensureScratchDir(tempRoot, "session-dead", "session");
			const claimed = await readTaskIsolationOwner(dir!);
			writeOwner(dir!, { ...claimed, pid: findDeadPid() });

			const again = await ensureScratchDir(tempRoot, "session-dead", "session");

			expect(again).toBe(dir);
			expect((await readTaskIsolationOwner(dir!))!.pid).toBe(process.pid);
		});

		it("re-asserts a dir on revive without touching its owner marker", async () => {
			const live = spawnLivePid();
			try {
				const dir = await ensureScratchDir(tempRoot, "session-revive", "session");
				const claimed = await readTaskIsolationOwner(dir!);
				writeOwner(dir!, { ...claimed, pid: live.pid });
				const before = fs.readFileSync(path.join(dir!, TASK_ISOLATION_OWNER_FILE), "utf8");
				fs.rmSync(path.join(dir!, "tmp"), { recursive: true, force: true });

				await assertScratchDir(dir!);

				expect(fs.statSync(path.join(dir!, "tmp")).isDirectory()).toBe(true);
				expect(fs.readFileSync(path.join(dir!, TASK_ISOLATION_OWNER_FILE), "utf8")).toBe(before);
			} finally {
				live.kill();
			}
		});
	});

	describe("D3 — symlinks at the root", () => {
		it("is skipped identically by the CLI and the in-process sweep", async () => {
			const precious = path.join(tempRoot, "precious");
			fs.mkdirSync(precious, { recursive: true });
			fs.writeFileSync(path.join(precious, "CANARY.txt"), "do not delete me", "utf8");
			const link = path.join(scratchRoot, "tsymlink");
			fs.symlinkSync(precious, link);
			ageMs(link, SCRATCH_DEAD_OWNER_GRACE_MS + 60_000);

			const listed = await captureOutput(() => listScratch({ json: true }));
			const swept = await sweepOrphanedScratchDirs();
			await captureOutput(() => clearScratch({ all: true, dryRun: false, yes: true, json: true }));

			expect(listed).not.toContain("tsymlink");
			expect(swept.removed).toEqual([]);
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.readFileSync(path.join(precious, "CANARY.txt"), "utf8")).toBe("do not delete me");
		});
	});

	describe("D4 — the run dir reaches a run's tools", () => {
		it("exports the run dir under its own name and the root under OMP_SCRATCH_DIR", () => {
			const env = buildScratchToolEnv(path.join(scratchRoot, "tabc123456"), false);

			expect(env).toEqual({
				OMP_RUN_SCRATCH: path.join(scratchRoot, "tabc123456"),
				OMP_SCRATCH_DIR: scratchRoot,
			});
		});

		it("adds the TMPDIR redirect only when it is enabled", () => {
			const env = buildScratchToolEnv(path.join(scratchRoot, "tabc123456"), true);

			expect(env?.TMPDIR).toBe(path.join(scratchRoot, "tabc123456", "tmp"));
			expect(env?.OMP_RUN_SCRATCH).toBe(path.join(scratchRoot, "tabc123456"));
		});
	});

	describe("clear --all safety", () => {
		/**
		 * `--all` on the DEFAULT root is the only case that can wipe the whole
		 * fleet's forensics window, and it is reachable by accident: a rejected
		 * `OMP_SCRATCH_DIR` substitutes that root silently. `default` is not
		 * reproducible in-process (it is derived from HOME at resolver
		 * construction), so these two run the real CLI with an isolated HOME.
		 */
		async function runCliClear(home: string, extraArgs: string[]): Promise<{ code: number; output: string }> {
			const proc = Bun.spawn(
				["bun", path.join(import.meta.dir, "..", "src", "cli.ts"), "scratch", "clear", ...extraArgs],
				{
					env: {
						PATH: process.env.PATH ?? "",
						HOME: home,
						OMP_WORKTREE_DIR: path.join(home, "wt"),
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { code, output: `${stdout}${stderr}` };
		}

		function makeIsolatedHome(): { home: string; orphan: string } {
			const home = path.join(tempRoot, "home");
			const orphan = path.join(home, ".loom", "scratch", "tdead12345");
			fs.mkdirSync(orphan, { recursive: true });
			writeOwner(orphan, {
				pid: findDeadPid(),
				startedAt: "2026-08-01T00:00:00.000Z",
				repoRoot: "/tmp",
				taskId: "Old",
				runId: "r0",
				worktree: "tx",
			});
			return { home, orphan };
		}

		it("refuses --all on the default fleet root without --yes, after naming every target", async () => {
			const { home, orphan } = makeIsolatedHome();

			const { code, output } = await runCliClear(home, ["--all"]);

			expect(output).toContain(orphan);
			expect(output).toContain("Refusing --all against the default scratch root");
			expect(code).toBe(1);
			expect(fs.existsSync(orphan)).toBe(true);
		}, 60_000);

		it("performs --all on the default fleet root once --yes is given", async () => {
			const { home, orphan } = makeIsolatedHome();

			const { code, output } = await runCliClear(home, ["--all", "--yes"]);

			expect(output).toContain(orphan);
			expect(code).toBe(0);
			expect(fs.existsSync(orphan)).toBe(false);
		}, 60_000);

		it("needs no confirmation for --all on an explicitly chosen root", async () => {
			// OMP_SCRATCH_DIR is set to the fixture root for this suite, so the
			// operator has named the target and no ceremony applies.
			const orphan = path.join(scratchRoot, "tdead12345");
			fs.mkdirSync(orphan, { recursive: true });
			writeOwner(orphan, makeDeadOwner());

			await captureOutput(() => clearScratch({ all: true, dryRun: false, yes: false, json: false }));

			expect(fs.existsSync(orphan)).toBe(false);
		});

		it("prints every target before unlinking it", async () => {
			const orphan = path.join(scratchRoot, "tdead12345");
			fs.mkdirSync(orphan, { recursive: true });
			writeOwner(orphan, makeDeadOwner());

			const output = await captureOutput(() => clearScratch({ all: true, dryRun: false, yes: false, json: false }));

			// Enumerate-then-delete: the names survive in the transcript even
			// when the removal is a mistake.
			const announced = output.indexOf(`would remove  ${orphan}`);
			const removed = output.indexOf(`removed  ${orphan}`);
			expect(announced).toBeGreaterThanOrEqual(0);
			expect(removed).toBeGreaterThan(announced);
		});

		it("makes --dry-run the same enumeration minus the unlink", async () => {
			const orphan = path.join(scratchRoot, "tdead12345");
			fs.mkdirSync(orphan, { recursive: true });
			writeOwner(orphan, makeDeadOwner());

			const dry = await captureOutput(() => clearScratch({ all: true, dryRun: true, yes: false, json: false }));

			expect(dry).toContain(`would remove  ${orphan}`);
			expect(dry).not.toContain(`removed  ${orphan}`);
			expect(fs.existsSync(orphan)).toBe(true);
		});

		it("reports the substituted root and its entry count when OMP_SCRATCH_DIR is rejected", async () => {
			// The substitution is what turned a fixture typo into a clear against
			// a root the operator never named. It must never be silent.
			const runDir = makeLiveRunDir(findDeadPid(), "trejected");
			process.env.OMP_SCRATCH_DIR = runDir;
			const orphan = path.join(fallbackRoot, "tdead12345");
			fs.mkdirSync(orphan, { recursive: true });
			writeOwner(orphan, makeDeadOwner());

			const output = await captureOutput(() => clearScratch({ all: true, dryRun: true, yes: false, json: false }));

			expect(output).toContain("Substituted scratch root");
			expect(output).toContain(runDir);
			expect(output).toContain(fallbackRoot);
			expect(output).toContain("1 entry");
		});
	});
});
