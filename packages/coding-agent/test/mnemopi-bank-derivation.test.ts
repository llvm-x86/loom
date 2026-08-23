import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	collectBankReposFromTouchedDirs,
	computeMnemopiBankScope,
	extendRecallWithLegacyBanks,
	loadMnemopiConfig,
	parseDeclaredBankRepo,
	resolveBankRepo,
	resolveBankRepoFromTouchedDirs,
	withTouchedRepoBankScope,
} from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

// Mnemopi is lazy-loaded at runtime; preload it so `MnemopiSessionState`'s
// synchronous construction below (via `createScopedResources`) can resolve
// the module, same as memory-tools.test.ts.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

// Set up a fixture filesystem we can reuse across the two regression
// suites — same shape as `~/.omp/memories/mnemopi/` on a real install.
let rootDir: TempDir;
let dbDir: string;
let banksDir: string;
let mainDbPath: string;

beforeAll(async () => {
	rootDir = await TempDir.create("@mnemopi-bank-derivation-");
	dbDir = rootDir.join("mnemopi");
	banksDir = path.join(dbDir, "banks");
	await fs.mkdir(banksDir, { recursive: true });
	mainDbPath = path.join(dbDir, "mnemopi.db");
});

afterAll(async () => {
	await Bun.sleep(0);
	await rootDir.remove();
});

// Schema mirrors the subset of `packages/mnemopi/src/core/beam/schema.ts`
// that this code path needs to probe. We deliberately do not run the
// full schema setup — the cwd-probing query only touches working_memory.
function createBankFixture(bank: string, metadataRows: readonly Record<string, unknown>[]): void {
	const bankDir = path.join(banksDir, bank);
	const dbPath = path.join(bankDir, "mnemopi.db");
	mkdirSync(bankDir, { recursive: true });
	const db = new Database(dbPath, { create: true });
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS working_memory (
				id TEXT PRIMARY KEY,
				content TEXT,
				metadata_json TEXT
			)
		`);
		const insert = db.prepare("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)");
		for (const [index, meta] of metadataRows.entries()) {
			insert.run(`row-${bank}-${index}`, "content", JSON.stringify(meta));
		}
	} finally {
		db.close();
	}
}

describe("computeMnemopiBankScope (#2412)", () => {
	// Regression: same cwd must hash to the same bank no matter what the
	// ambient git layout looks like. The previous derivation walked
	// `git.repo.resolveSync(cwd)?.repoRoot ?? path.resolve(cwd)`, so a
	// disappearing/appearing ancestor `.git` repointed the same conversation
	// directory to a different bank and stranded its memories.
	it("returns the same per-project bank for one cwd regardless of git state", async () => {
		const baseDir = await TempDir.create("@mnemopi-stable-bank-");
		try {
			const project = baseDir.join("projects", "omp-workstation");
			await fs.mkdir(project, { recursive: true });
			const withoutGit = computeMnemopiBankScope(undefined, project, "per-project").bank;

			// Plant an ancestor `.git` marker — the old code path resolved
			// `project` to `baseDir/projects` via this file, producing a
			// `projects-<hash>` bank id distinct from the cwd-derived one.
			await fs.mkdir(baseDir.join("projects"), { recursive: true });
			await fs.writeFile(baseDir.join("projects", ".git"), "gitdir: /dev/null\n");
			const withAncestorGit = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(withAncestorGit).toBe(withoutGit);

			await removeWithRetries(baseDir.join("projects", ".git"));
			const afterGitRemoved = computeMnemopiBankScope(undefined, project, "per-project").bank;
			expect(afterGitRemoved).toBe(withoutGit);
		} finally {
			await Bun.sleep(0);
			await baseDir.remove();
		}
	});

	it("derives different banks for different cwds (sanity)", () => {
		const a = computeMnemopiBankScope(undefined, "/projects/repo-a", "per-project").bank;
		const b = computeMnemopiBankScope(undefined, "/projects/repo-b", "per-project").bank;
		expect(a).not.toBe(b);
	});

	it("per-project-tagged opens both the project bank and the shared default", () => {
		const scope = computeMnemopiBankScope(undefined, "/projects/repo", "per-project-tagged");
		expect(scope.retainBank).toBe(scope.bank);
		expect(scope.recallBanks).toContain(scope.bank);
		expect(scope.recallBanks).toContain("default");
	});

	it("global ignores the cwd entirely", () => {
		const here = computeMnemopiBankScope(undefined, "/projects/here", "global");
		const there = computeMnemopiBankScope(undefined, "/elsewhere", "global");
		expect(here).toEqual(there);
		expect(here.bank).toBe("default");
	});
});

describe("computeMnemopiBankScope repo-keyed (LOOM_MNEMOPI_BANK_REPO)", () => {
	it("pins one repository to one bank regardless of checkout path or account", () => {
		// kevin's session in his home and ubuntu's in its own home — the
		// console passes the same GitHub slug, so both must resolve to the
		// exact same bank id (no cwd component).
		const slug = "Family-Fun-Group/BehaviorOS";
		const kevin = computeMnemopiBankScope(undefined, "/home/kevin/workspace/BehaviorOS", "per-project", slug);
		const ubuntu = computeMnemopiBankScope(undefined, "/home/ubuntu/workspace/BehaviorOS", "per-project", slug);
		expect(ubuntu.bank).toBe(kevin.bank);
		expect(ubuntu.bank).toBe("Family-Fun-Group-BehaviorOS");
	});

	it("repo key still participates in per-project-tagged recall", () => {
		const scope = computeMnemopiBankScope(
			undefined,
			"/elsewhere/landing-pages",
			"per-project-tagged",
			"Family-Fun-Group/landing-pages",
		);
		expect(scope.retainBank).toBe("Family-Fun-Group-landing-pages");
		expect(scope.recallBanks).toContain("Family-Fun-Group-landing-pages");
		expect(scope.recallBanks).toContain("default");
	});

	it("repo key composes with a configured shared bank base", () => {
		const scope = computeMnemopiBankScope("acme", "/anywhere", "per-project", "acme/skyrail");
		expect(scope.bank).toBe("acme-acme-skyrail");
	});

	it("repo key is ignored under global scoping", () => {
		const scope = computeMnemopiBankScope(undefined, "/anywhere", "global", "someone/else");
		expect(scope.bank).toBe("default");
	});

	it("distinct repositories get distinct banks", () => {
		const a = computeMnemopiBankScope(undefined, "/x/a", "per-project", "Family-Fun-Group/BehaviorOS").bank;
		const b = computeMnemopiBankScope(undefined, "/x/b", "per-project", "Family-Fun-Group/landing-pages").bank;
		expect(a).not.toBe(b);
	});

	it("omitting or blanking the repo key falls back to cwd derivation", () => {
		const blank = computeMnemopiBankScope(undefined, "/projects/repo", "per-project", "   ").bank;
		const omitted = computeMnemopiBankScope(undefined, "/projects/repo", "per-project").bank;
		expect(blank).toBe(omitted);
	});
});

describe("extendRecallWithLegacyBanks (#2412)", () => {
	it("adds a sibling bank only when all working_memory rows tag the active cwd", () => {
		const activeCwd = path.join(rootDir.path(), "projects", "myrepo");
		createBankFixture("legacy-A", [{ session_id: "old", cwd: activeCwd }]);
		createBankFixture("unrelated-B", [{ session_id: "other", cwd: path.join(rootDir.path(), "other", "place") }]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, activeCwd);
		expect(extended).toContain("active-bank");
		expect(extended).toContain("legacy-A");
		expect(extended).not.toContain("unrelated-B");
	});

	it("skips mixed-cwd legacy banks because recall cannot filter rows by cwd", () => {
		const childCwd = path.join(rootDir.path(), "projects", "safe-child");
		createBankFixture("mixed-cwd-legacy", [
			{ cwd: childCwd },
			{ cwd: path.join(rootDir.path(), "projects", "sibling-child") },
		]);
		const extended = extendRecallWithLegacyBanks(["active-bank"], mainDbPath, childCwd);
		expect(extended).not.toContain("mixed-cwd-legacy");
	});
});

describe("extendRecallWithLegacyBanks edge cases", () => {
	it("ignores banks already in the recall set", () => {
		const cwd = path.join(rootDir.path(), "projects", "already-in-set");
		createBankFixture("already-in-set", [{ cwd }]);
		const extended = extendRecallWithLegacyBanks(["already-in-set"], mainDbPath, cwd);
		expect(extended).toEqual(["already-in-set"]);
	});

	it("returns the input unchanged when banks/ does not exist", () => {
		const missingRoot = rootDir.join("no-such-mnemopi", "mnemopi.db");
		const out = extendRecallWithLegacyBanks(["one"], missingRoot, "/home/user/anywhere");
		expect(out).toEqual(["one"]);
	});

	it("tolerates a corrupt bank database without throwing", async () => {
		const corruptDir = path.join(banksDir, "corrupt-C");
		await fs.mkdir(corruptDir, { recursive: true });
		await fs.writeFile(path.join(corruptDir, "mnemopi.db"), "not a sqlite file");
		const out = extendRecallWithLegacyBanks(["active"], mainDbPath, path.join(rootDir.path(), "some", "cwd"));
		expect(out).toContain("active");
		expect(out).not.toContain("corrupt-C");
	});
});

// Isolate from ambient user/system git config (signing, templates, etc.) so
// `git init` / `git remote add` in these fixtures stay deterministic —
// mirrors the isolation used by test/tools/gh.test.ts and hindsight-bank.test.ts.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
// The pin outranks every derivation step by design, so a shell that exports
// LOOM_MNEMOPI_BANK_REPO (console lanes do, per session) silently rewrites the
// expected bank for 17 of the tests below. Drop it: these suites exist to
// exercise the DERIVATION, and the pin's own precedence is asserted explicitly
// via `mnemopi.bankRepo` settings fixtures.
delete process.env.LOOM_MNEMOPI_BANK_REPO;

async function initGitRepoWithOrigin(dir: string, originUrl?: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await $`git init --initial-branch=main`.cwd(dir).quiet();
	if (originUrl) await $`git remote add origin ${originUrl}`.cwd(dir).quiet();
}

describe("resolveBankRepo (lazy git-origin derivation)", () => {
	it("an explicit pin wins over a real git origin", async () => {
		const dir = await TempDir.create("@mnemopi-pin-wins-");
		try {
			await initGitRepoWithOrigin(dir.path(), "git@github.com:Family-Fun-Group/BehaviorOS.git");
			const settings = await Settings.isolated({ "mnemopi.bankRepo": "acme/pinned-repo" }).cloneForCwd(dir.path());
			expect(resolveBankRepo(dir.path(), settings)).toBe("acme/pinned-repo");
		} finally {
			await dir.remove();
		}
	});

	it("derives owner-repo from an SSH-form origin", async () => {
		const dir = await TempDir.create("@mnemopi-ssh-origin-");
		try {
			await initGitRepoWithOrigin(dir.path(), "git@github.com:Family-Fun-Group/BehaviorOS.git");
			expect(resolveBankRepo(dir.path())).toBe("Family-Fun-Group/BehaviorOS");
		} finally {
			await dir.remove();
		}
	});

	it("derives owner-repo from an HTTPS origin with a trailing .git", async () => {
		const dir = await TempDir.create("@mnemopi-https-git-origin-");
		try {
			await initGitRepoWithOrigin(dir.path(), "https://github.com/Family-Fun-Group/BehaviorOS.git");
			expect(resolveBankRepo(dir.path())).toBe("Family-Fun-Group/BehaviorOS");
		} finally {
			await dir.remove();
		}
	});

	it("derives owner-repo from an HTTPS origin without a trailing .git", async () => {
		const dir = await TempDir.create("@mnemopi-https-plain-origin-");
		try {
			await initGitRepoWithOrigin(dir.path(), "https://github.com/Family-Fun-Group/BehaviorOS");
			expect(resolveBankRepo(dir.path())).toBe("Family-Fun-Group/BehaviorOS");
		} finally {
			await dir.remove();
		}
	});

	it("falls back to the cwd-hash bank when there is no enclosing git root", async () => {
		const dir = await TempDir.create("@mnemopi-no-git-root-");
		try {
			expect(resolveBankRepo(dir.path())).toBeUndefined();
			const scope = computeMnemopiBankScope(undefined, dir.path(), "per-project", resolveBankRepo(dir.path()));
			const cwdOnly = computeMnemopiBankScope(undefined, dir.path(), "per-project", undefined);
			expect(scope.bank).toBe(cwdOnly.bank);
		} finally {
			await dir.remove();
		}
	});

	it("falls back to the cwd-hash bank when the git repo has no origin remote", async () => {
		const dir = await TempDir.create("@mnemopi-no-origin-");
		try {
			await initGitRepoWithOrigin(dir.path());
			expect(resolveBankRepo(dir.path())).toBeUndefined();
		} finally {
			await dir.remove();
		}
	});

	// Regression: an isolated task / run-scratch dir is NOT a checkout, so the
	// git walk finds nothing and the bank used to fall back to the cwd hash.
	// Real memory landed in per-run drawers named after the isolation segment
	// (`t<digest>-<hash>`) — 86 stranded rows across 95 such banks on the
	// reference install — where recall for the repo could never reach it. The
	// dir's `owner.json` names the checkout it was cut from; inherit its origin.
	it("inherits the bank repo from a managed run dir's owner marker", async () => {
		const repo = await TempDir.create("@mnemopi-owner-repo-");
		const scratch = await TempDir.create("@mnemopi-owner-scratch-");
		try {
			await initGitRepoWithOrigin(repo.path(), "git@github.com:Family-Fun-Group/SkyRail.git");
			await fs.writeFile(
				path.join(scratch.path(), "owner.json"),
				JSON.stringify({
					pid: process.pid,
					repoRoot: repo.path(),
					taskId: "t1",
					runId: "r1",
					worktree: "t0e43fdbf5",
				}),
			);
			expect(resolveBankRepo(scratch.path())).toBe("Family-Fun-Group/SkyRail");
			// The whole point: same bank as the parent session, not a t-drawer.
			expect(
				computeMnemopiBankScope(undefined, scratch.path(), "per-project", resolveBankRepo(scratch.path())).bank,
			).toBe(computeMnemopiBankScope(undefined, repo.path(), "per-project", resolveBankRepo(repo.path())).bank);
		} finally {
			await repo.remove();
			await scratch.remove();
		}
	});

	it("inherits from an owner marker in a parent dir of the cwd", async () => {
		const repo = await TempDir.create("@mnemopi-owner-nested-repo-");
		const scratch = await TempDir.create("@mnemopi-owner-nested-");
		try {
			await initGitRepoWithOrigin(repo.path(), "https://github.com/Family-Fun-Group/kanban.git");
			await fs.writeFile(path.join(scratch.path(), "owner.json"), JSON.stringify({ repoRoot: repo.path() }));
			const nested = path.join(scratch.path(), "work", "deep");
			await fs.mkdir(nested, { recursive: true });
			expect(resolveBankRepo(nested)).toBe("Family-Fun-Group/kanban");
		} finally {
			await repo.remove();
			await scratch.remove();
		}
	});

	// A spawn from outside any checkout records repoRoot === the dir itself.
	// There is no parent git config to inherit, so the cwd-hash fallback must
	// stand rather than the resolver looping on the same failed lookup.
	it("keeps the cwd-hash fallback when the owner marker names no checkout", async () => {
		const scratch = await TempDir.create("@mnemopi-owner-self-");
		try {
			await fs.writeFile(path.join(scratch.path(), "owner.json"), JSON.stringify({ repoRoot: scratch.path() }));
			expect(resolveBankRepo(scratch.path())).toBeUndefined();
		} finally {
			await scratch.remove();
		}
	});

	it("keeps the cwd-hash fallback for a malformed or repoRoot-less owner marker", async () => {
		const bad = await TempDir.create("@mnemopi-owner-bad-");
		const empty = await TempDir.create("@mnemopi-owner-empty-");
		try {
			await fs.writeFile(path.join(bad.path(), "owner.json"), "{not json");
			await fs.writeFile(path.join(empty.path(), "owner.json"), JSON.stringify({ pid: 1, worktree: "t9" }));
			expect(resolveBankRepo(bad.path())).toBeUndefined();
			expect(resolveBankRepo(empty.path())).toBeUndefined();
		} finally {
			await bad.remove();
			await empty.remove();
		}
	});

	// The cwd's own origin still outranks the marker: a scratch CLONE is a real
	// checkout, and cloning repo B inside a dir cut from repo A must key on B.
	it("prefers the cwd's own git origin over the owner marker", async () => {
		const parent = await TempDir.create("@mnemopi-owner-prec-parent-");
		const clone = await TempDir.create("@mnemopi-owner-prec-clone-");
		try {
			await initGitRepoWithOrigin(parent.path(), "git@github.com:Family-Fun-Group/SkyRail.git");
			await initGitRepoWithOrigin(clone.path(), "git@github.com:llvm-x86/agent-chat.git");
			await fs.writeFile(path.join(clone.path(), "owner.json"), JSON.stringify({ repoRoot: parent.path() }));
			expect(resolveBankRepo(clone.path())).toBe("llvm-x86/agent-chat");
		} finally {
			await parent.remove();
			await clone.remove();
		}
	});
});

describe("loadMnemopiConfig recall union for lazily-derived repo banks", () => {
	it("recalls both the git-derived slug bank and the cwd-derived bank the same cwd would otherwise use", async () => {
		const projectDir = await TempDir.create("@mnemopi-recall-union-");
		const agentDir = await TempDir.create("@mnemopi-recall-union-agent-");
		try {
			await initGitRepoWithOrigin(projectDir.path(), "git@github.com:Family-Fun-Group/BehaviorOS.git");
			const settings = await Settings.isolated({ "mnemopi.scoping": "per-project" }).cloneForCwd(projectDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());

			const slugBank = computeMnemopiBankScope(
				undefined,
				projectDir.path(),
				"per-project",
				"Family-Fun-Group/BehaviorOS",
			).bank;
			const cwdOnlyBank = computeMnemopiBankScope(undefined, projectDir.path(), "per-project", undefined).bank;

			expect(config.bank).toBe(slugBank);
			expect(config.recallBanks).toContain(slugBank);
			expect(config.recallBanks).toContain(cwdOnlyBank);
		} finally {
			await projectDir.remove();
			await agentDir.remove();
		}
	});

	it("does not add a cwd bank when the repo slug is an explicit pin", async () => {
		const projectDir = await TempDir.create("@mnemopi-pinned-no-union-");
		const agentDir = await TempDir.create("@mnemopi-pinned-no-union-agent-");
		try {
			const settings = await Settings.isolated({
				"mnemopi.scoping": "per-project",
				"mnemopi.bankRepo": "acme/pinned",
			}).cloneForCwd(projectDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());
			const cwdOnlyBank = computeMnemopiBankScope(undefined, projectDir.path(), "per-project", undefined).bank;
			expect(config.recallBanks).not.toContain(cwdOnlyBank);
		} finally {
			await projectDir.remove();
			await agentDir.remove();
		}
	});
});

describe("touched-repo bank derivation (console-lane fallback)", () => {
	it("resolveBankRepoFromTouchedDirs picks the first dir (recency order is the caller's job) that resolves a real origin", async () => {
		const noOrigin = await TempDir.create("@mnemopi-touched-no-origin-");
		const withOrigin = await TempDir.create("@mnemopi-touched-with-origin-");
		try {
			await initGitRepoWithOrigin(noOrigin.path());
			await initGitRepoWithOrigin(withOrigin.path(), "git@github.com:Family-Fun-Group/SkyRail.git");
			expect(resolveBankRepoFromTouchedDirs([noOrigin.path(), withOrigin.path()])).toBe("Family-Fun-Group/SkyRail");
			expect(resolveBankRepoFromTouchedDirs([noOrigin.path()])).toBeUndefined();
		} finally {
			await noOrigin.remove();
			await withOrigin.remove();
		}
	});

	it("collectBankReposFromTouchedDirs dedupes and skips dirs with no origin", async () => {
		const repoA = await TempDir.create("@mnemopi-touched-collect-a-");
		const repoB = await TempDir.create("@mnemopi-touched-collect-b-");
		const noOrigin = await TempDir.create("@mnemopi-touched-collect-none-");
		try {
			await initGitRepoWithOrigin(repoA.path(), "git@github.com:acme/repo-a.git");
			await initGitRepoWithOrigin(repoB.path(), "git@github.com:acme/repo-b.git");
			await initGitRepoWithOrigin(noOrigin.path());
			const slugs = collectBankReposFromTouchedDirs([repoA.path(), noOrigin.path(), repoB.path(), repoA.path()]);
			expect(slugs).toEqual(["acme/repo-a", "acme/repo-b"]);
		} finally {
			await repoA.remove();
			await repoB.remove();
			await noOrigin.remove();
		}
	});

	it("withTouchedRepoBankScope widens recall to every touched repo while writing only to the winner", async () => {
		const cwd = "/tmp/workspace";
		const settings = await Settings.isolated({ "mnemopi.scoping": "per-project" }).cloneForCwd(cwd);
		const base = loadMnemopiConfig(settings, "/tmp/agent-dir");
		const scoped = withTouchedRepoBankScope(base, cwd, "acme/winner", ["acme/winner", "acme/other"]);
		const winnerBank = computeMnemopiBankScope(undefined, cwd, "per-project", "acme/winner").bank;
		const otherBank = computeMnemopiBankScope(undefined, cwd, "per-project", "acme/other").bank;
		const cwdOnlyBank = computeMnemopiBankScope(undefined, cwd, "per-project", undefined).bank;
		expect(scoped.bank).toBe(winnerBank);
		expect(scoped.retainBank).toBe(winnerBank);
		expect(scoped.recallBanks).toContain(winnerBank);
		expect(scoped.recallBanks).toContain(otherBank);
		// The cwd-hash bank the pin-less, touched-repo-less config already read
		// from must stay in the union — no orphaned rows.
		expect(scoped.recallBanks).toContain(cwdOnlyBank);
	});
});

describe("MnemopiSessionState.maybeRebindTouchedRepoBank (console-lane mid-session rebind)", () => {
	// Isolate from any real repo tests run from (no git dir walks up past the fixture).
	function toolCallMessage(name: string, args: Record<string, unknown>): unknown {
		return { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] };
	}

	it("keys the write bank to a touched checkout's origin, not the workspace-hash bank, and rebinds when the touched repo changes", async () => {
		const containerDir = await TempDir.create("@mnemopi-console-lane-"); // simulates `~/workspace`: no origin of its own
		const agentDir = await TempDir.create("@mnemopi-console-lane-agent-");
		let state: MnemopiSessionState | undefined;
		try {
			const skyRailDir = path.join(containerDir.path(), "SkyRail");
			const otherDir = path.join(containerDir.path(), "OtherRepo");
			await initGitRepoWithOrigin(skyRailDir, "git@github.com:Family-Fun-Group/SkyRail.git");
			await initGitRepoWithOrigin(otherDir, "git@github.com:Family-Fun-Group/OtherRepo.git");

			const settings = await Settings.isolated({
				"mnemopi.scoping": "per-project",
				"mnemopi.noEmbeddings": true,
				"mnemopi.autoRecall": false,
				"mnemopi.autoRetain": false,
				"mnemopi.treeEnabled": false,
			}).cloneForCwd(containerDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());

			// Precondition: booted outside any repo, no pin — bankRepo unresolved
			// at boot, eligible for touched-repo derivation, and the bank in play
			// right now is the plain cwd-hash `workspace-<hash>` bank.
			expect(config.bankRepo).toBeUndefined();
			expect(config.bankRepoLocked).toBe(false);
			const cwdOnlyBank = computeMnemopiBankScope(undefined, containerDir.path(), "per-project", undefined).bank;
			expect(config.bank).toBe(cwdOnlyBank);

			const messages: unknown[] = [];
			const session = {
				sessionId: "console-lane-session",
				messages,
				sessionManager: {
					getCwd: () => containerDir.path(),
					getEntries: () => [],
				},
			} as never;
			state = new MnemopiSessionState({ sessionId: "console-lane-session", config, session });

			// Acceptance scenario: session touches SkyRail (a real checkout with
			// an origin) purely through a tool call — the write bank must follow.
			messages.push(toolCallMessage("edit", { path: path.join(skyRailDir, "a.ts") }));
			await state.beforeAgentStartPrompt("continue");
			const skyRailBank = computeMnemopiBankScope(
				undefined,
				containerDir.path(),
				"per-project",
				"Family-Fun-Group/SkyRail",
			).bank;
			expect(state.config.bank).toBe(skyRailBank);
			expect(state.config.bank).not.toBe(cwdOnlyBank);
			expect(state.config.recallBanks).toContain(skyRailBank);
			expect(state.config.recallBanks).toContain(cwdOnlyBank); // no orphaned rows

			// Re-running with no new messages must not rebind (message-count
			// throttle: nothing new to detect) — the retain target stays the
			// exact same open Mnemopi handle.
			const retainMemoryAfterFirstRebind = state.getScopedRetainTarget().memory;
			await state.beforeAgentStartPrompt("continue");
			expect(state.getScopedRetainTarget().memory).toBe(retainMemoryAfterFirstRebind);

			// A new message that touches the SAME repo again must not rebind
			// either — the touched-repo *answer* (winner + set) is unchanged,
			// even though the transcript grew.
			messages.push(toolCallMessage("edit", { path: path.join(skyRailDir, "b.ts") }));
			await state.beforeAgentStartPrompt("continue");
			expect(state.getScopedRetainTarget().memory).toBe(retainMemoryAfterFirstRebind);
			expect(state.config.bank).toBe(skyRailBank);

			// Touching a DIFFERENT repo more recently must rebind the write bank
			// to the new winner, while recall keeps every bank seen so far.
			messages.push(toolCallMessage("edit", { path: path.join(otherDir, "c.ts") }));
			await state.beforeAgentStartPrompt("continue");
			const otherBank = computeMnemopiBankScope(
				undefined,
				containerDir.path(),
				"per-project",
				"Family-Fun-Group/OtherRepo",
			).bank;
			expect(state.config.bank).toBe(otherBank);
			expect(state.getScopedRetainTarget().memory).not.toBe(retainMemoryAfterFirstRebind);
			expect(state.config.recallBanks).toContain(otherBank);
			expect(state.config.recallBanks).toContain(skyRailBank);
			expect(state.config.recallBanks).toContain(cwdOnlyBank);
		} finally {
			await state?.dispose({ consolidate: false });
			await containerDir.remove();
			await agentDir.remove();
		}
	});

	// Regression: the rebind used to run ONLY at `beforeAgentStartPrompt`,
	// which scans the messages present when a turn STARTS. A task subagent
	// gets one prompt and one turn, so at its only start hook nothing had been
	// touched yet and its transcript retained into the cwd-hash drawer named
	// after its isolation dir (`t<digest>-<hash>`) — 95 such banks holding 86
	// rows of ordinary repo work on the reference install, invisible to recall
	// for the repo. The write paths must re-derive first: by `agent_end` the
	// turn's tool calls are in the transcript.
	it("rebinds on the retain path for a single-turn session that never hit a start hook", async () => {
		const containerDir = await TempDir.create("@mnemopi-single-turn-");
		const agentDir = await TempDir.create("@mnemopi-single-turn-agent-");
		let state: MnemopiSessionState | undefined;
		try {
			const skyRailDir = path.join(containerDir.path(), "SkyRail");
			await initGitRepoWithOrigin(skyRailDir, "git@github.com:Family-Fun-Group/SkyRail.git");
			const settings = await Settings.isolated({
				"mnemopi.scoping": "per-project",
				"mnemopi.noEmbeddings": true,
				"mnemopi.autoRecall": false,
				"mnemopi.autoRetain": true,
				"mnemopi.treeEnabled": false,
			}).cloneForCwd(containerDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());
			const cwdOnlyBank = computeMnemopiBankScope(undefined, containerDir.path(), "per-project", undefined).bank;
			expect(config.bank).toBe(cwdOnlyBank);

			const messages: unknown[] = [];
			const session = {
				sessionId: "single-turn-session",
				messages,
				sessionManager: { getCwd: () => containerDir.path(), getEntries: () => [] },
			} as never;
			state = new MnemopiSessionState({ sessionId: "single-turn-session", config, session });

			// The subagent's one turn edits a checkout, then ends. No start hook
			// ever ran with those messages in view.
			messages.push(toolCallMessage("edit", { path: path.join(skyRailDir, "fix.ts") }));
			await state.maybeRetainOnAgentEnd([]);

			const skyRailBank = computeMnemopiBankScope(
				undefined,
				containerDir.path(),
				"per-project",
				"Family-Fun-Group/SkyRail",
			).bank;
			expect(state.config.bank).toBe(skyRailBank);
			expect(state.config.bank).not.toBe(cwdOnlyBank);
			expect(state.config.recallBanks).toContain(cwdOnlyBank);
		} finally {
			await state?.dispose?.();
			await containerDir.remove();
			await agentDir.remove();
		}
	});

	// Same for the shutdown/close write path the context-sync worker drives.
	it("rebinds on the forced-retain path", async () => {
		const containerDir = await TempDir.create("@mnemopi-force-retain-");
		const agentDir = await TempDir.create("@mnemopi-force-retain-agent-");
		let state: MnemopiSessionState | undefined;
		try {
			const repoDir = path.join(containerDir.path(), "kanban");
			await initGitRepoWithOrigin(repoDir, "https://github.com/Family-Fun-Group/kanban.git");
			const settings = await Settings.isolated({
				"mnemopi.scoping": "per-project",
				"mnemopi.noEmbeddings": true,
				"mnemopi.autoRecall": false,
				"mnemopi.autoRetain": false,
				"mnemopi.treeEnabled": false,
			}).cloneForCwd(containerDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());
			const messages: unknown[] = [];
			const session = {
				sessionId: "force-retain-session",
				messages,
				sessionManager: { getCwd: () => containerDir.path(), getEntries: () => [] },
			} as never;
			state = new MnemopiSessionState({ sessionId: "force-retain-session", config, session });
			// A strong touch (a write), not a `read`: only writes claim the bank.
			messages.push(toolCallMessage("edit", { path: path.join(repoDir, "README.md") }));
			await state.forceRetainCurrentSession();
			expect(state.config.bank).toBe(
				computeMnemopiBankScope(undefined, containerDir.path(), "per-project", "Family-Fun-Group/kanban").bank,
			);
		} finally {
			await state?.dispose?.();
			await containerDir.remove();
			await agentDir.remove();
		}
	});
});

describe("parseDeclaredBankRepo (agent-declared `repo` validation)", () => {
	it("accepts a well-formed owner/repo slug", () => {
		expect(parseDeclaredBankRepo("Family-Fun-Group/SkyRail")).toBe("Family-Fun-Group/SkyRail");
	});

	it("rejects a slug with no slash", () => {
		expect(parseDeclaredBankRepo("not-a-slug")).toBeUndefined();
	});

	it("rejects a slug with too many segments", () => {
		expect(parseDeclaredBankRepo("a/b/c/d")).toBeUndefined();
	});

	it("rejects an empty string", () => {
		expect(parseDeclaredBankRepo("")).toBeUndefined();
	});

	it("rejects a segment sanitizeBankName would have to mangle", () => {
		expect(parseDeclaredBankRepo("acme/sky rail")).toBeUndefined();
	});

	// Real repositories carry dots (`vercel/next.js`), and the git-origin path
	// (parseOwnerRepoSlug) has always accepted them — so rejecting them here
	// made a repo declarable by inference but not by hand.
	it("accepts dotted owner and repo names", () => {
		expect(parseDeclaredBankRepo("vercel/next.js")).toBe("vercel/next.js");
		expect(parseDeclaredBankRepo("owner/my.repo.io")).toBe("owner/my.repo.io");
	});

	it("strips a trailing .git like the remote-URL path does", () => {
		expect(parseDeclaredBankRepo("owner/repo.git")).toBe("owner/repo");
	});

	it("rejects empty, dot, and dot-dot segments", () => {
		expect(parseDeclaredBankRepo("owner//repo")).toBeUndefined();
		expect(parseDeclaredBankRepo("owner/.")).toBeUndefined();
		expect(parseDeclaredBankRepo("../etc")).toBeUndefined();
	});
});

describe("MnemopiSessionState.declareBankRepo (agent-declared bank repo)", () => {
	function toolCallMessage(name: string, args: Record<string, unknown>): unknown {
		return { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] };
	}

	it("keys the write bank to the declared repo instead of the workspace-hash bank, and stays sticky across a later turn with no new declaration", async () => {
		const containerDir = await TempDir.create("@mnemopi-declared-repo-"); // no git origin of its own
		const agentDir = await TempDir.create("@mnemopi-declared-repo-agent-");
		let state: MnemopiSessionState | undefined;
		try {
			const settings = await Settings.isolated({
				"mnemopi.scoping": "per-project",
				"mnemopi.noEmbeddings": true,
				"mnemopi.autoRecall": false,
				"mnemopi.autoRetain": false,
				"mnemopi.treeEnabled": false,
			}).cloneForCwd(containerDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());
			expect(config.bankRepo).toBeUndefined();
			expect(config.bankRepoPinned).toBe(false);
			const cwdOnlyBank = computeMnemopiBankScope(undefined, containerDir.path(), "per-project", undefined).bank;
			expect(config.bank).toBe(cwdOnlyBank);

			const messages: unknown[] = [];
			const session = {
				sessionId: "declared-repo-session",
				messages,
				sessionManager: { getCwd: () => containerDir.path(), getEntries: () => [] },
			} as never;
			state = new MnemopiSessionState({ sessionId: "declared-repo-session", config, session });

			await state.declareBankRepo("Family-Fun-Group/SkyRail");
			const declaredBank = computeMnemopiBankScope(
				undefined,
				containerDir.path(),
				"per-project",
				"Family-Fun-Group/SkyRail",
			).bank;
			expect(declaredBank).toBe("Family-Fun-Group-SkyRail");
			expect(state.config.bank).toBe(declaredBank);
			expect(state.config.bank).not.toBe(cwdOnlyBank);
			// Recall still includes the cwd-hash bank — nothing already written becomes unreachable.
			expect(state.config.recallBanks).toContain(cwdOnlyBank);

			// Stickiness: a later turn with no fresh `repo` declaration must not
			// fall back off the declared bank.
			messages.push(toolCallMessage("edit", { path: path.join(containerDir.path(), "x.ts") }));
			await state.beforeAgentStartPrompt("continue");
			expect(state.config.bank).toBe(declaredBank);
		} finally {
			await state?.dispose({ consolidate: false });
			await containerDir.remove();
			await agentDir.remove();
		}
	});

	it("an operator pin still beats a declared repo", async () => {
		const containerDir = await TempDir.create("@mnemopi-declared-pin-");
		const agentDir = await TempDir.create("@mnemopi-declared-pin-agent-");
		let state: MnemopiSessionState | undefined;
		try {
			const settings = await Settings.isolated({
				"mnemopi.scoping": "per-project",
				"mnemopi.bankRepo": "acme/pinned",
				"mnemopi.noEmbeddings": true,
				"mnemopi.autoRecall": false,
				"mnemopi.autoRetain": false,
				"mnemopi.treeEnabled": false,
			}).cloneForCwd(containerDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());
			expect(config.bankRepoPinned).toBe(true);
			const pinnedBank = computeMnemopiBankScope(undefined, containerDir.path(), "per-project", "acme/pinned").bank;
			expect(config.bank).toBe(pinnedBank);

			const messages: unknown[] = [];
			const session = {
				sessionId: "declared-pin-session",
				messages,
				sessionManager: { getCwd: () => containerDir.path(), getEntries: () => [] },
			} as never;
			state = new MnemopiSessionState({ sessionId: "declared-pin-session", config, session });

			await state.declareBankRepo("Family-Fun-Group/SkyRail");
			expect(state.config.bank).toBe(pinnedBank);
		} finally {
			await state?.dispose({ consolidate: false });
			await containerDir.remove();
			await agentDir.remove();
		}
	});

	it("a declared repo beats cwd's own git origin and touched-repo inference", async () => {
		const cwdRepoDir = await TempDir.create("@mnemopi-declared-vs-origin-");
		const agentDir = await TempDir.create("@mnemopi-declared-vs-origin-agent-");
		let state: MnemopiSessionState | undefined;
		try {
			await initGitRepoWithOrigin(cwdRepoDir.path(), "git@github.com:Family-Fun-Group/OriginRepo.git");
			const settings = await Settings.isolated({
				"mnemopi.scoping": "per-project",
				"mnemopi.noEmbeddings": true,
				"mnemopi.autoRecall": false,
				"mnemopi.autoRetain": false,
				"mnemopi.treeEnabled": false,
			}).cloneForCwd(cwdRepoDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());
			// Precondition: cwd's own origin already resolved the bank at boot
			// (precedence step d), with no operator pin.
			expect(config.bankRepo).toBe("Family-Fun-Group/OriginRepo");
			expect(config.bankRepoPinned).toBe(false);

			const messages: unknown[] = [];
			const session = {
				sessionId: "declared-vs-origin-session",
				messages,
				sessionManager: { getCwd: () => cwdRepoDir.path(), getEntries: () => [] },
			} as never;
			state = new MnemopiSessionState({ sessionId: "declared-vs-origin-session", config, session });

			await state.declareBankRepo("Family-Fun-Group/SkyRail");
			const declaredBank = computeMnemopiBankScope(
				undefined,
				cwdRepoDir.path(),
				"per-project",
				"Family-Fun-Group/SkyRail",
			).bank;
			expect(state.config.bank).toBe(declaredBank);

			// The throttled per-turn scan must not regress the write bank back
			// to the cwd-origin winner once a new message triggers a rescan.
			messages.push(toolCallMessage("edit", { path: path.join(cwdRepoDir.path(), "a.ts") }));
			await state.beforeAgentStartPrompt("continue");
			expect(state.config.bank).toBe(declaredBank);
		} finally {
			await state?.dispose({ consolidate: false });
			await cwdRepoDir.remove();
			await agentDir.remove();
		}
	});

	it("recovers a declared repo from the transcript on --resume, without a new tool call", async () => {
		const containerDir = await TempDir.create("@mnemopi-declared-resume-");
		const agentDir = await TempDir.create("@mnemopi-declared-resume-agent-");
		let state: MnemopiSessionState | undefined;
		try {
			const settings = await Settings.isolated({
				"mnemopi.scoping": "per-project",
				"mnemopi.noEmbeddings": true,
				"mnemopi.autoRecall": false,
				"mnemopi.autoRetain": false,
				"mnemopi.treeEnabled": false,
			}).cloneForCwd(containerDir.path());
			const config = loadMnemopiConfig(settings, agentDir.path());

			// Simulate --resume: the transcript already carries the prior
			// `memory` tool call with a `repo` argument; this fresh state was
			// never told about it directly (no `declareBankRepo` call).
			const messages: unknown[] = [
				toolCallMessage("memory", { action: "add", content: "fact", repo: "Family-Fun-Group/SkyRail" }),
			];
			const session = {
				sessionId: "declared-resume-session",
				messages,
				sessionManager: { getCwd: () => containerDir.path(), getEntries: () => [] },
			} as never;
			state = new MnemopiSessionState({ sessionId: "declared-resume-session", config, session });

			await state.beforeAgentStartPrompt("continue");
			const declaredBank = computeMnemopiBankScope(
				undefined,
				containerDir.path(),
				"per-project",
				"Family-Fun-Group/SkyRail",
			).bank;
			expect(state.config.bank).toBe(declaredBank);
		} finally {
			await state?.dispose({ consolidate: false });
			await containerDir.remove();
			await agentDir.remove();
		}
	});
});
