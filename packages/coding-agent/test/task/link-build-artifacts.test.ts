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
