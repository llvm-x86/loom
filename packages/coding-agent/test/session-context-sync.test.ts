/**
 * Contracts: `sessionContextSync.maybeSync` — the per-repo status ledger sync.
 *
 * 1. Disabled or unset `dir` -> zero `runEphemeralTurn` calls (total no-op).
 * 2. Happy path -> writes the ledger file atomically with the model's output,
 *    stripping a code fence if present.
 * 3. Malformed model output (no heading) -> no write, warns.
 * 4. Debounce: two rapid non-shutdown syncs -> second is skipped; `shutdown`
 *    bypasses the debounce.
 * 5. In-flight guard: concurrent `maybeSync` calls -> exactly one
 *    `runEphemeralTurn` call.
 * 6. Slug falls back to the cwd basename when repo resolution fails.
 *
 * Multi-repo mode (cwd is a container, not itself a checkout):
 * 7. Two touched repos -> two ledgers written from a JSON-map reply.
 * 8. Bogus bash tokens (git ref ranges, URLs, scp-like remotes, non-existent
 *    dirs) never trigger a `resolveRepo` (gh) call.
 * 9. One real repo among noise -> goes through the single-repo path (one
 *    ephemeral turn, single-repo prompt/output format).
 * 10. Unparseable multi-repo reply -> no writes at all, existing ledgers for
 *     every touched repo are left untouched, and it warns.
 * 11. A reply with a JSON map wrapped in a fence plus surrounding prose still
 *     parses and writes both ledgers.
 * 12. Relative `..` targets and absolute paths outside `workspaceRoot` are
 *     rejected as touched dirs (never reach `resolveRepo`).
 * 13. Two touched dirs that resolve to the same repo slug dedupe to a single
 *     ledger write (one ephemeral turn), not a doubled/racing write.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	maybeSync,
	type SessionContextSyncSession,
	type SessionContextSyncSettings,
} from "@oh-my-pi/pi-coding-agent/utils/session-context-sync";
import { logger } from "@oh-my-pi/pi-utils";

function makeSettings(overrides: Partial<SessionContextSyncSettings> = {}): SessionContextSyncSettings {
	return {
		enabled: true,
		dir: "",
		idleMinutes: 10,
		minIntervalSeconds: 120,
		workspaceRoot: "",
		...overrides,
	};
}

function makeSession(
	cwd: string,
	settings: SessionContextSyncSettings,
	replyText: string,
): { session: SessionContextSyncSession; calls: number } {
	const state = { calls: 0 };
	const session: SessionContextSyncSession = {
		cwd,
		sessionId: "test-session",
		settings: { getGroup: () => settings },
		messages: [{ role: "user" }] as unknown[],
		runEphemeralTurn: async () => {
			state.calls++;
			return { replyText };
		},
	};
	return { session, calls: state.calls };
}

describe("sessionContextSync", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-context-sync-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is a no-op when disabled", async () => {
		let calls = 0;
		const session: SessionContextSyncSession = {
			cwd: dir,
			settings: { getGroup: () => makeSettings({ enabled: false, dir }) },
			messages: [{ role: "user" }],
			runEphemeralTurn: async () => {
				calls++;
				return { replyText: "# repo — status ledger\n" };
			},
		};
		await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });
		expect(calls).toBe(0);
	});

	it("is a no-op when dir is unset", async () => {
		let calls = 0;
		const session: SessionContextSyncSession = {
			cwd: dir,
			settings: { getGroup: () => makeSettings({ enabled: true, dir: "" }) },
			messages: [{ role: "user" }],
			runEphemeralTurn: async () => {
				calls++;
				return { replyText: "# repo — status ledger\n" };
			},
		};
		await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });
		expect(calls).toBe(0);
	});

	it("writes the ledger file atomically, stripping a code fence", async () => {
		const settings = makeSettings({ dir });
		const modelOutput = "```markdown\n# owner/repo — status ledger\n\n## Current state\nAll good.\n```";
		const { session } = makeSession(dir, settings, modelOutput);

		await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

		const ledgerPath = join(dir, "owner-repo.md");
		expect(existsSync(ledgerPath)).toBe(true);
		const content = readFileSync(ledgerPath, "utf8");
		expect(content).toContain("# owner/repo — status ledger");
		expect(content).toContain("## Current state");
		expect(content).not.toContain("```");
	});

	it("aborts the write and warns on malformed (headingless) model output", async () => {
		const settings = makeSettings({ dir });
		const { session } = makeSession(dir, settings, "just some prose, no heading at all");
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });
			const ledgerPath = join(dir, "owner-repo.md");
			expect(existsSync(ledgerPath)).toBe(false);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("debounces rapid non-shutdown syncs but shutdown bypasses the debounce", async () => {
		const settings = makeSettings({ dir, minIntervalSeconds: 120 });
		let calls = 0;
		let now = 1_000_000;
		const session: SessionContextSyncSession = {
			cwd: dir,
			settings: { getGroup: () => settings },
			messages: [{ role: "user" }],
			runEphemeralTurn: async () => {
				calls++;
				return { replyText: `# owner/repo — status ledger\ncall ${calls}\n` };
			},
		};
		const deps = { resolveRepo: async () => "owner/repo", now: () => now };

		await maybeSync(session, "compaction", deps);
		expect(calls).toBe(1);

		now += 1_000; // 1s later, well under the 120s debounce window
		await maybeSync(session, "compaction", deps);
		expect(calls).toBe(1);

		await maybeSync(session, "shutdown", deps);
		expect(calls).toBe(2);
	});

	it("in-flight guard: concurrent maybeSync calls make exactly one runEphemeralTurn call", async () => {
		const settings = makeSettings({ dir });
		let calls = 0;
		const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();
		const session: SessionContextSyncSession = {
			cwd: dir,
			settings: { getGroup: () => settings },
			messages: [{ role: "user" }],
			runEphemeralTurn: async () => {
				calls++;
				await gate;
				return { replyText: "# owner/repo — status ledger\nin flight\n" };
			},
		};
		const deps = { resolveRepo: async () => "owner/repo" };

		const first = maybeSync(session, "compaction", deps);
		const second = maybeSync(session, "compaction", deps);
		releaseGate();
		await Promise.all([first, second]);

		expect(calls).toBe(1);
	});

	it("falls back to the cwd basename when repo resolution fails", async () => {
		const settings = makeSettings({ dir });
		const cwd = join(dir, "my-project");
		const { session } = makeSession(cwd, settings, "# ignored — status ledger\nbody\n");

		await maybeSync(session, "compaction", {
			resolveRepo: async () => {
				throw new Error("not a git checkout");
			},
		});

		expect(existsSync(join(dir, "my-project.md"))).toBe(true);
	});

	it("multi-repo: two touched repos write two ledgers via one focused turn each", async () => {
		const settings = makeSettings({ dir, workspaceRoot: "" });
		const repoADir = join(dir, "repoA");
		const repoBDir = join(dir, "repoB");
		mkdirSync(repoADir, { recursive: true });
		mkdirSync(repoBDir, { recursive: true });

		const resolveRepo = async (cwd: string) => {
			if (cwd === repoADir) return "owner/repoA";
			if (cwd === repoBDir) return "owner/repoB";
			throw new Error(`not a checkout: ${cwd}`);
		};
		// One focused turn per repo; the prompt names the repo slug, so the mock
		// returns that repo's ledger by matching the slug in the prompt text.
		const ledgerFor: Record<string, string> = {
			"owner-repoA": "# owner/repoA — status ledger\n\n## Current state\nWorked on A.",
			"owner-repoB": "# owner/repoB — status ledger\n\n## Current state\nWorked on B.",
		};

		const session: SessionContextSyncSession = {
			cwd: dir,
			sessionId: "multi-two-repos",
			settings: { getGroup: () => settings },
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: { path: join(repoADir, "file1.ts") } }],
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { path: join(repoBDir, "file2.ts") } }],
				},
			],
			runEphemeralTurn: async ({ promptText }) => {
				const slug = promptText.includes('repo "owner-repoA"') ? "owner-repoA" : "owner-repoB";
				return { replyText: ledgerFor[slug] };
			},
		};

		await maybeSync(session, "compaction", { resolveRepo });

		expect(readFileSync(join(dir, "owner-repoA.md"), "utf8")).toContain("Worked on A.");
		expect(readFileSync(join(dir, "owner-repoB.md"), "utf8")).toContain("Worked on B.");
	});

	it("multi-repo: bogus bash tokens (git refs, URLs, scp remotes, non-existent dirs) never call resolveRepo", async () => {
		const settings = makeSettings({ dir, workspaceRoot: "" });
		const calls: string[] = [];
		const resolveRepo = async (cwd: string) => {
			calls.push(cwd);
			throw new Error(`not a checkout: ${cwd}`);
		};
		const command = [
			"git diff origin/main...feature/x",
			"&&",
			"curl https://example.com/foo/bar",
			"&&",
			"git remote add origin git@github.com:owner/repo.git",
			"&&",
			"cat nonexistent-repo/file.txt",
		].join(" ");

		const session: SessionContextSyncSession = {
			cwd: dir,
			sessionId: "multi-bogus-tokens",
			settings: { getGroup: () => settings },
			messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] }],
			runEphemeralTurn: async () => ({ replyText: "# fallback — status ledger\nbody\n" }),
		};

		await maybeSync(session, "compaction", { resolveRepo });

		// Only the initial single-repo check on `session.cwd` runs; none of the
		// bogus tokens (ref range, URL, scp remote, non-existent dir) ever reach
		// `resolveRepo`, so no bogus `gh` subprocess is spawned.
		expect(calls).toEqual([dir]);
		expect(existsSync(join(dir, `${basename(dir)}.md`))).toBe(true);
	});

	it("multi-repo: one real repo among noise goes through the single-repo path", async () => {
		const settings = makeSettings({ dir, workspaceRoot: "" });
		const repoADir = join(dir, "repoA");
		mkdirSync(repoADir, { recursive: true });

		const calls: string[] = [];
		const resolveRepo = async (cwd: string) => {
			calls.push(cwd);
			if (cwd === repoADir) return "owner/repoA";
			throw new Error(`not a checkout: ${cwd}`);
		};
		const command = [
			"git diff origin/main...feature/x",
			"&&",
			"curl https://example.com/foo/bar",
			"&&",
			"cat nonexistent-repo/file.txt",
		].join(" ");

		let turnCalls = 0;
		const session: SessionContextSyncSession = {
			cwd: dir,
			sessionId: "multi-single-among-noise",
			settings: { getGroup: () => settings },
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] },
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: { path: join(repoADir, "file.ts") } }],
				},
			],
			runEphemeralTurn: async () => {
				turnCalls++;
				return { replyText: "# owner/repoA — status ledger\n\n## Current state\nfoo" };
			},
		};

		await maybeSync(session, "compaction", { resolveRepo });

		// cwd (single-repo check) + repoA only — bogus tokens never resolved.
		expect(calls).toEqual([dir, repoADir]);
		expect(turnCalls).toBe(1);
		expect(existsSync(join(dir, "owner-repoA.md"))).toBe(true);
	});

	it("multi-repo: each repo's turn is independent — unparseable output leaves that ledger untouched and warns", async () => {
		const settings = makeSettings({ dir, workspaceRoot: "" });
		const repoADir = join(dir, "repoA");
		const repoBDir = join(dir, "repoB");
		mkdirSync(repoADir, { recursive: true });
		mkdirSync(repoBDir, { recursive: true });
		writeFileSync(join(dir, "owner-repoA.md"), "# owner/repoA — status ledger\n\nOLD A\n");
		writeFileSync(join(dir, "owner-repoB.md"), "# owner/repoB — status ledger\n\nOLD B\n");

		const resolveRepo = async (cwd: string) => {
			if (cwd === repoADir) return "owner/repoA";
			if (cwd === repoBDir) return "owner/repoB";
			throw new Error(`not a checkout: ${cwd}`);
		};

		const session: SessionContextSyncSession = {
			cwd: dir,
			sessionId: "multi-unparseable",
			settings: { getGroup: () => settings },
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: { path: join(repoADir, "a.ts") } }],
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: { path: join(repoBDir, "b.ts") } }],
				},
			],
			runEphemeralTurn: async () => ({ replyText: "Sorry, I can't produce that right now." }),
		};

		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await maybeSync(session, "compaction", { resolveRepo });
			expect(readFileSync(join(dir, "owner-repoA.md"), "utf8")).toBe("# owner/repoA — status ledger\n\nOLD A\n");
			expect(readFileSync(join(dir, "owner-repoB.md"), "utf8")).toBe("# owner/repoB — status ledger\n\nOLD B\n");
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("multi-repo: a fenced markdown reply is unfenced; a headingless repo is skipped independently", async () => {
		const settings = makeSettings({ dir, workspaceRoot: "" });
		const repoADir = join(dir, "repoA");
		const repoBDir = join(dir, "repoB");
		mkdirSync(repoADir, { recursive: true });
		mkdirSync(repoBDir, { recursive: true });

		const resolveRepo = async (cwd: string) => {
			if (cwd === repoADir) return "owner/repoA";
			if (cwd === repoBDir) return "owner/repoB";
			throw new Error(`not a checkout: ${cwd}`);
		};
		// repoA: valid ledger wrapped in a code fence (must be unfenced + written).
		// repoB: headingless prose (must be skipped, warns) — independent of repoA.
		const replyFor: Record<string, string> = {
			"owner-repoA": "```markdown\n# owner/repoA — status ledger\n\n## Current state\nFenced A.\n```",
			"owner-repoB": "no heading here, just prose",
		};

		const session: SessionContextSyncSession = {
			cwd: dir,
			sessionId: "multi-independent",
			settings: { getGroup: () => settings },
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: { path: join(repoADir, "a.ts") } }],
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: { path: join(repoBDir, "b.ts") } }],
				},
			],
			runEphemeralTurn: async ({ promptText }) => {
				const slug = promptText.includes('repo "owner-repoA"') ? "owner-repoA" : "owner-repoB";
				return { replyText: replyFor[slug] };
			},
		};

		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await maybeSync(session, "compaction", { resolveRepo });
			const a = readFileSync(join(dir, "owner-repoA.md"), "utf8");
			expect(a).toContain("Fenced A.");
			expect(a).not.toContain("```");
			expect(existsSync(join(dir, "owner-repoB.md"))).toBe(false);
			expect(warnSpy).toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("multi-repo: '..' and absolute paths outside workspaceRoot are rejected, never reaching resolveRepo", async () => {
		const settings = makeSettings({ dir, workspaceRoot: "" });
		const outsideDir = mkdtempSync(join(tmpdir(), "session-context-sync-outside-"));
		try {
			const calls: string[] = [];
			const resolveRepo = async (cwd: string) => {
				calls.push(cwd);
				throw new Error(`not a checkout: ${cwd}`);
			};
			const command = `cd ../../etc && cat ${outsideDir}/secret.txt`;

			const session: SessionContextSyncSession = {
				cwd: dir,
				sessionId: "multi-outside-root",
				settings: { getGroup: () => settings },
				messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] }],
				runEphemeralTurn: async () => ({ replyText: "# fallback — status ledger\nbody\n" }),
			};

			await maybeSync(session, "compaction", { resolveRepo });

			// Only the single-repo check on `session.cwd` runs — the `..` escape
			// and the absolute path outside `workspaceRoot` never surface as
			// touched dirs.
			expect(calls).toEqual([dir]);
			expect(existsSync(join(dir, `${basename(dir)}.md`))).toBe(true);
		} finally {
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("multi-repo: two dirs resolving to the same slug dedupe to a single ledger write", async () => {
		const settings = makeSettings({ dir, workspaceRoot: "" });
		const cloneA = join(dir, "repoA-clone1");
		const cloneB = join(dir, "repoA-clone2");
		mkdirSync(cloneA, { recursive: true });
		mkdirSync(cloneB, { recursive: true });

		const resolveRepo = async (cwd: string) => {
			if (cwd === cloneA || cwd === cloneB) return "owner/repoA";
			throw new Error(`not a checkout: ${cwd}`);
		};

		let turnCalls = 0;
		const session: SessionContextSyncSession = {
			cwd: dir,
			sessionId: "multi-dedupe",
			settings: { getGroup: () => settings },
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: { path: join(cloneA, "a.ts") } }],
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "edit", arguments: { path: join(cloneB, "b.ts") } }],
				},
			],
			runEphemeralTurn: async () => {
				turnCalls++;
				return { replyText: "# owner/repoA — status ledger\n\n## Current state\nDeduped." };
			},
		};

		await maybeSync(session, "compaction", { resolveRepo });

		expect(turnCalls).toBe(1);
		expect(readFileSync(join(dir, "owner-repoA.md"), "utf8")).toContain("Deduped.");
	});

	it("multi-repo: a ~/-prefixed tool path is tilde-expanded and detected under workspaceRoot", async () => {
		// workspaceRoot must live under HOME so a `~/…` path resolves into it.
		const wsRoot = mkdtempSync(join(homedir(), ".sctest-ws-"));
		try {
			const repoDir = join(wsRoot, "repoA");
			mkdirSync(repoDir, { recursive: true });
			const settings = makeSettings({ dir, workspaceRoot: wsRoot });
			const resolveRepo = async (cwd: string) => {
				if (cwd === repoDir) return "owner/repoA";
				throw new Error(`not a checkout: ${cwd}`);
			};
			const command = `cd ~/${basename(wsRoot)}/repoA && git status`;
			const session: SessionContextSyncSession = {
				cwd: dir,
				sessionId: "multi-tilde",
				settings: { getGroup: () => settings },
				messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command } }] }],
				runEphemeralTurn: async () => ({ replyText: "# owner/repoA — status ledger\n\n## Current state\nTilde." }),
			};

			await maybeSync(session, "compaction", { resolveRepo });

			expect(readFileSync(join(dir, "owner-repoA.md"), "utf8")).toContain("Tilde.");
		} finally {
			rmSync(wsRoot, { recursive: true, force: true });
		}
	});
});
