/**
 * Isolation capture integrity — the merge-back path's two silent-data-loss
 * defects, exercised against real git repositories.
 *
 * D1: a diff larger than the git output ceiling used to come back with a
 *     truncation marker spliced in. `git apply --cached` then failed, the patch
 *     artifact was never written, and the isolation worktree was deleted in
 *     `finally` — a successful subagent's entire change set gone with "merge
 *     failed" as the only trace.
 * D2: ignored paths are invisible to git plumbing, so writes to `.env`, local
 *     config or build output never came back and were never mentioned.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureBaseline,
	captureDeltaPatch,
	captureIgnoredChanges,
	getGitNoIndexNullPath,
	type WorktreeBaseline,
} from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { $ } from "bun";

/** Line length chosen so 170_000 lines clear the 8 MiB ceiling with margin. */
const BLOB_LINE = `${"y".repeat(58)}\n`;
const BLOB_LINES = 170_000;
const BLOB_BYTES = BLOB_LINE.length * BLOB_LINES;

let root: string;
let repo: string;
let iso: string;

async function commitAll(dir: string, message: string): Promise<void> {
	await $`git -C ${dir} add -A`.quiet();
	await $`git -C ${dir} -c user.email=t@t -c user.name=t commit -qm ${message}`.quiet();
}

/** Materialise the isolation copy the way a copy backend does: byte-for-byte. */
async function cloneToIsolation(): Promise<void> {
	await fs.cp(repo, iso, { recursive: true, verbatimSymlinks: true });
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-capture-"));
	// realpath: git reports the resolved root, and the delta capture compares
	// paths against `baseline.root.repoRoot`.
	root = await fs.realpath(root);
	repo = path.join(root, "repo");
	iso = path.join(root, "iso");
	await fs.mkdir(repo, { recursive: true });
	await $`git init -q ${repo}`.quiet();
	await Bun.write(path.join(repo, "tracked.txt"), "base\n");
	await Bun.write(path.join(repo, ".gitignore"), ".env\ndist/\n");
	await commitAll(repo, "init");
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("D1 — oversized diffs no longer destroy the change set", () => {
	it("captures a >8 MiB untracked file and merges it back", async () => {
		const baseline: WorktreeBaseline = await captureBaseline(repo);
		await cloneToIsolation();

		// The packet's repro: `yes … | head -n 170000 > blob.dat` inside the
		// isolation worktree, alongside an ordinary tracked edit.
		await Bun.write(path.join(iso, "blob.dat"), BLOB_LINE.repeat(BLOB_LINES));
		await Bun.write(path.join(iso, "tracked.txt"), "changed\n");

		const delta = await captureDeltaPatch(iso, baseline);
		expect(delta.rootPatch).not.toContain(git.GIT_OUTPUT_TRUNCATED_MARKER_PREFIX);
		expect(delta.rootPatch.length).toBeGreaterThan(git.GIT_COMMAND_OUTPUT_LIMIT_BYTES);

		await git.patch.applyText(repo, delta.rootPatch);
		expect((await fs.stat(path.join(repo, "blob.dat"))).size).toBe(BLOB_BYTES);
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("changed\n");
	});

	it("raises a named error rather than handing back a truncated diff", async () => {
		await Bun.write(path.join(repo, "big.txt"), "x".repeat(100_000));

		const capture = git.diff.capture(repo, {
			allowFailure: true,
			binary: true,
			noIndex: { left: getGitNoIndexNullPath(), right: "big.txt" },
			maxOutputBytes: 4096,
		});
		await expect(capture).rejects.toThrow(/^diff exceeded capture limit: \d+ bytes \(limit 4096 bytes\)$/);

		// Same command inside the real ceiling: complete text, no marker.
		const whole = await git.diff.capture(repo, {
			allowFailure: true,
			binary: true,
			noIndex: { left: getGitNoIndexNullPath(), right: "big.txt" },
		});
		expect(whole).not.toContain(git.GIT_OUTPUT_TRUNCATED_MARKER_PREFIX);
		expect(whole.length).toBeGreaterThan(100_000);
	});

	it("refuses to build a synthetic tree from marker-bearing patch text", async () => {
		// Guards the capture sites this branch does not own (branch-mode commit
		// replay still captures through plain `git.diff.tree`): a marker-bearing
		// patch must fail by name, not as "corrupt patch at line N".
		const baseline: WorktreeBaseline = await captureBaseline(repo);
		await cloneToIsolation();
		baseline.root.staged = `diff --git a/tracked.txt b/tracked.txt\n${git.GIT_OUTPUT_TRUNCATED_MARKER_PREFIX}8388608 bytes]\n`;

		await expect(captureDeltaPatch(iso, baseline)).rejects.toThrow(/truncated by the git output limit/);
	});
});

describe("D2 — gitignored divergence is reported by name", () => {
	it("names added, modified and removed ignored paths", async () => {
		await Bun.write(path.join(repo, ".env"), "TOKEN=parent\n");
		await Bun.write(path.join(repo, "dist/stale.js"), "old\n");
		await cloneToIsolation();

		await Bun.write(path.join(iso, ".env"), "TOKEN=agent\n");
		await Bun.write(path.join(iso, "dist/app.js"), "built\n");
		await fs.rm(path.join(iso, "dist/stale.js"));

		const scan = await captureIgnoredChanges(iso, repo);
		expect(scan.unscanned).toEqual([]);
		expect(scan.changes).toEqual([
			{ relativePath: ".env", status: "modified", bytes: 12 },
			{ relativePath: "dist/app.js", status: "added", bytes: 6 },
			{ relativePath: "dist/stale.js", status: "removed", bytes: 0 },
		]);
	});

	it("names files in an ignored directory the agent created from nothing", async () => {
		// `dist/` exists only inside the isolation copy: the parent-side walk hits
		// ENOENT, which must read as "empty", not as an unscanned failure.
		await cloneToIsolation();
		await Bun.write(path.join(iso, "dist/app.js"), "built\n");

		const scan = await captureIgnoredChanges(iso, repo);
		expect(scan.unscanned).toEqual([]);
		expect(scan.changes).toEqual([{ relativePath: "dist/app.js", status: "added", bytes: 6 }]);
	});

	it("stays silent when every ignored path matches the parent", async () => {
		await Bun.write(path.join(repo, ".env"), "TOKEN=parent\n");
		await Bun.write(path.join(repo, "dist/app.js"), "built\n");
		await cloneToIsolation();
		await Bun.write(path.join(iso, "tracked.txt"), "only tracked work\n");

		const scan = await captureIgnoredChanges(iso, repo);
		expect(scan).toEqual({ changes: [], unscanned: [] });
	});

	it("catches a same-size content edit to an ignored file", async () => {
		await Bun.write(path.join(repo, ".env"), "TOKEN=aaaaa\n");
		await cloneToIsolation();
		await Bun.write(path.join(iso, ".env"), "TOKEN=bbbbb\n");

		const scan = await captureIgnoredChanges(iso, repo);
		expect(scan.changes).toEqual([{ relativePath: ".env", status: "modified", bytes: 12 }]);
	});

	it("compares inside a wholly-ignored directory by size only (documented trade-off)", async () => {
		// Contents of a collapsed ignored directory are compared by name, size and
		// link target — hashing a dependency tree on every spawn costs far more
		// than the answer is worth. A same-size in-place edit under `dist/` is the
		// case knowingly traded away; a size change is still caught.
		await Bun.write(path.join(repo, "dist/app.js"), "aaaaa\n");
		await cloneToIsolation();
		await Bun.write(path.join(iso, "dist/app.js"), "bbbbb\n");
		expect((await captureIgnoredChanges(iso, repo)).changes).toEqual([]);

		await Bun.write(path.join(iso, "dist/app.js"), "bbbbbb\n");
		expect((await captureIgnoredChanges(iso, repo)).changes).toEqual([
			{ relativePath: "dist/app.js", status: "modified", bytes: 7 },
		]);
	});

	it("reports a diverging ignored symlink by target", async () => {
		await Bun.write(path.join(repo, "target-a.txt"), "a\n");
		await Bun.write(path.join(repo, "target-b.txt"), "b\n");
		await Bun.write(path.join(repo, ".gitignore"), ".env\ndist/\nlink\n");
		await commitAll(repo, "ignore link");
		await fs.symlink("target-a.txt", path.join(repo, "link"));
		await cloneToIsolation();

		await fs.rm(path.join(iso, "link"));
		await fs.symlink("target-b.txt", path.join(iso, "link"));

		const scan = await captureIgnoredChanges(iso, repo);
		expect(scan.changes.map(change => change.relativePath)).toEqual(["link"]);
		expect(scan.changes[0]?.status).toBe("modified");
	});
});
