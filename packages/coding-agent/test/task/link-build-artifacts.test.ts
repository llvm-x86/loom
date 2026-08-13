import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	NATIVES_RELATIVE_DIR,
	TOOL_VIEWS_RELATIVE,
	linkParentBuildArtifacts,
	shouldSkipLinkedIgnoredEntry,
} from "@oh-my-pi/pi-coding-agent/task/link-build-artifacts";
import { captureIgnoredChanges } from "@oh-my-pi/pi-coding-agent/task/worktree";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("linkParentBuildArtifacts", () => {
	it("copies readonly generated artifacts without symlinking node_modules", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-ro-"));
		tempDirs.push(repo);
		const merged = path.join(repo, "merged");
		await fs.mkdir(merged, { recursive: true });
		await fs.mkdir(path.join(repo, NATIVES_RELATIVE_DIR), { recursive: true });
		await fs.writeFile(path.join(repo, NATIVES_RELATIVE_DIR, "demo.node"), "native");
		await fs.mkdir(path.dirname(path.join(repo, TOOL_VIEWS_RELATIVE)), { recursive: true });
		await fs.writeFile(path.join(repo, TOOL_VIEWS_RELATIVE), "views");
		await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
		await fs.writeFile(path.join(repo, "node_modules", "pkg.txt"), "parent");

		const { linked } = await linkParentBuildArtifacts(repo, merged, "readonly");

		expect(linked).toContain(`${NATIVES_RELATIVE_DIR}/demo.node`);
		expect(linked).toContain(TOOL_VIEWS_RELATIVE);
		expect(linked.some(entry => entry.startsWith("node_modules"))).toBe(false);
		await expect(fs.readFile(path.join(merged, TOOL_VIEWS_RELATIVE), "utf8")).resolves.toBe("views");
		await expect(fs.lstat(path.join(merged, "node_modules"))).rejects.toThrow();
	});

	it("symlinks node_modules and target in full mode", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-full-"));
		tempDirs.push(repo);
		const merged = path.join(repo, "merged");
		await fs.mkdir(merged, { recursive: true });
		await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
		await fs.mkdir(path.join(repo, "target"), { recursive: true });
		await fs.mkdir(path.join(repo, NATIVES_RELATIVE_DIR), { recursive: true });
		await fs.writeFile(path.join(repo, NATIVES_RELATIVE_DIR, "demo.node"), "native");

		const { linked } = await linkParentBuildArtifacts(repo, merged, "full");

		expect(linked).toContain("node_modules/");
		expect(linked).toContain("target/");
		const nm = await fs.readlink(path.join(merged, "node_modules"));
		expect(nm).toBe(path.join(repo, "node_modules"));
	});

	it("skips paths that already exist in the worktree", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-skip-"));
		tempDirs.push(repo);
		const merged = path.join(repo, "merged");
		await fs.mkdir(path.join(merged, NATIVES_RELATIVE_DIR), { recursive: true });
		await fs.mkdir(path.join(repo, NATIVES_RELATIVE_DIR), { recursive: true });
		await fs.writeFile(path.join(repo, NATIVES_RELATIVE_DIR, "demo.node"), "parent");
		await fs.writeFile(path.join(merged, NATIVES_RELATIVE_DIR, "demo.node"), "local");

		const { linked } = await linkParentBuildArtifacts(repo, merged, "readonly");

		expect(linked).not.toContain(`${NATIVES_RELATIVE_DIR}/demo.node`);
		await expect(fs.readFile(path.join(merged, NATIVES_RELATIVE_DIR, "demo.node"), "utf8")).resolves.toBe("local");
	});

	it("seeds configured paths a Python project needs: venv symlinked, .env copied", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-cfg-"));
		tempDirs.push(repo);
		const merged = path.join(repo, "merged");
		await fs.mkdir(merged, { recursive: true });
		await fs.mkdir(path.join(repo, "venv", "bin"), { recursive: true });
		await fs.writeFile(path.join(repo, "venv", "bin", "python"), "interpreter");
		await fs.writeFile(path.join(repo, ".env"), "TOKEN=parent");

		const { linked, warnings } = await linkParentBuildArtifacts(repo, merged, "off", ["venv", ".env"]);

		expect(warnings).toEqual([]);
		expect(linked).toContain("venv/");
		expect(linked).toContain(".env");
		// The interpreter must be reachable through the worktree, or the
		// subagent's test command dies on the first import.
		await expect(fs.readFile(path.join(merged, "venv", "bin", "python"), "utf8")).resolves.toBe("interpreter");
		expect((await fs.lstat(path.join(merged, "venv"))).isSymbolicLink()).toBe(true);
		// A file is copied, not linked: rewriting .env in the worktree must not
		// reach the parent checkout.
		expect((await fs.lstat(path.join(merged, ".env"))).isSymbolicLink()).toBe(false);
		await fs.writeFile(path.join(merged, ".env"), "TOKEN=child");
		await expect(fs.readFile(path.join(repo, ".env"), "utf8")).resolves.toBe("TOKEN=parent");
	});

	it("honours configured paths independently of mode off and ignores absent ones", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-off-"));
		tempDirs.push(repo);
		const merged = path.join(repo, "merged");
		await fs.mkdir(merged, { recursive: true });
		await fs.mkdir(path.dirname(path.join(repo, TOOL_VIEWS_RELATIVE)), { recursive: true });
		await fs.writeFile(path.join(repo, TOOL_VIEWS_RELATIVE), "views");
		await fs.writeFile(path.join(repo, ".env"), "TOKEN=parent");

		const { linked, warnings } = await linkParentBuildArtifacts(repo, merged, "off", [".env", "no-such-dir"]);

		// "off" suppresses loom's own generated outputs but never the operator's allowlist.
		expect(linked).toEqual([".env"]);
		expect(warnings).toEqual([]);
	});

	it("refuses configured paths that escape the repository root", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-esc-"));
		tempDirs.push(repo);
		const merged = path.join(repo, "merged");
		await fs.mkdir(merged, { recursive: true });

		const { linked, warnings } = await linkParentBuildArtifacts(repo, merged, "off", [
			"../outside",
			"/etc",
			".",
		]);

		expect(linked).toEqual([]);
		expect(warnings).toHaveLength(3);
		expect(warnings.every(warning => warning.includes("outside the repository root"))).toBe(true);
	});

	it("excludes configured paths from the ignored-divergence report", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-skip-"));
		tempDirs.push(repo);
		await fs.writeFile(path.join(repo, ".env"), "TOKEN=parent");
		const merged = path.join(repo, "merged");
		await fs.mkdir(merged, { recursive: true });

		// Unconfigured: the worktree genuinely lacks .env, so divergence reports it.
		const bare = await linkParentBuildArtifacts(repo, merged, "off");
		expect(shouldSkipLinkedIgnoredEntry(".env", bare.linked)).toBe(false);

		const seeded = await linkParentBuildArtifacts(repo, merged, "off", [".env", "venv"]);
		expect(shouldSkipLinkedIgnoredEntry(".env", seeded.linked)).toBe(true);
	});
});

describe("shouldSkipLinkedIgnoredEntry", () => {
	it("matches directory roots and nested paths", () => {
		expect(shouldSkipLinkedIgnoredEntry("node_modules/", ["node_modules/"])).toBe(true);
		expect(shouldSkipLinkedIgnoredEntry("node_modules/foo/bar", ["node_modules/"])).toBe(true);
		expect(shouldSkipLinkedIgnoredEntry(".env", ["node_modules/"])).toBe(false);
	});
});

describe("captureIgnoredChanges skipLinkedArtifacts", () => {
	it("does not report removed node_modules when the parent had one and isolation inherited it", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ignored-skip-"));
		tempDirs.push(repo);
		const merged = path.join(repo, "merged");
		await fs.mkdir(merged, { recursive: true });
		await Bun.spawn(["git", "init"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		await Bun.spawn(["git", "config", "user.email", "t@e.com"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		await Bun.spawn(["git", "config", "user.name", "T"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		await fs.writeFile(path.join(repo, "tracked.txt"), "x\n");
		await Bun.spawn(["git", "add", "tracked.txt"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		await Bun.spawn(["git", "commit", "-m", "init"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited;
		await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
		await fs.writeFile(path.join(repo, "node_modules", "pkg.txt"), "p");

		const scan = await captureIgnoredChanges(merged, repo, { skipLinkedArtifacts: ["node_modules/"] });
		expect(scan.changes.some(change => change.relativePath.startsWith("node_modules"))).toBe(false);
	});
});
