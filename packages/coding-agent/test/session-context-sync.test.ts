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
		spoolDir: "",
		controlFile: "",
		reportUrl: "",
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

	it("opts out of the ephemeral display cap so a ledger over 4096 bytes is written whole", async () => {
		// Regression: this reply is written to a FILE. Without `dedupeReply: false` it goes
		// through dedupeEphemeralReply(), which caps at EPHEMERAL_REPLY_MAX_BYTES (4096) and
		// appends "\n[…truncated]" — producing a 4097-byte ledger cut mid-word. Eight project
		// ledgers were silently truncated that way before the cause was found.
		const settings = makeSettings({ dir });
		// Bulk under a NON-hazard heading: the cut-invariant guard (correctly) refuses
		// to persist a ledger whose hazard section ends past the 4096-byte window, so
		// hazard bulk would test the guard rather than the dedupe opt-out.
		const big = `# owner/repo — status ledger\n\n## Recent changes\n${"- a narrative entry that must survive.\n".repeat(120)}`;
		expect(big.length).toBeGreaterThan(4096);
		let seenDedupeReply: boolean | undefined = true;
		const session: SessionContextSyncSession = {
			cwd: dir,
			settings: { getGroup: () => settings },
			messages: [{ role: "user" }],
			runEphemeralTurn: async args => {
				seenDedupeReply = args.dedupeReply;
				return { replyText: big };
			},
		};

		await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

		expect(seenDedupeReply).toBe(false);
		const content = readFileSync(join(dir, "owner-repo.md"), "utf8");
		expect(content).not.toContain("[…truncated]");
		expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(4096);
		expect(content.split("\n").filter(l => l.startsWith("- ")).length).toBe(120);
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

	describe("cut-invariant write guard", () => {
		const INTACT =
			"# owner/repo — status ledger\n\n## Landmines\n- ⚠️ a standing constraint.\n\n## Current state\nIntact.\n";
		const seed = (): string => {
			const ledgerPath = join(dir, "owner-repo.md");
			writeFileSync(ledgerPath, INTACT, "utf8");
			return ledgerPath;
		};

		it("refuses a reply carrying the truncation marker and keeps the previous file", async () => {
			const ledgerPath = seed();
			const cut = `# owner/repo — status ledger\n\n## Landmines\n- ⚠️ a standing cons\n[…truncated]`;
			const { session } = makeSession(dir, makeSettings({ dir }), cut);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			expect(readFileSync(ledgerPath, "utf8")).toBe(INTACT);
		});

		it("refuses a marker-less reply landing exactly at the cap boundary", async () => {
			const ledgerPath = seed();
			// Exactly 4097 bytes, no marker: the silent prefix-cut signature.
			let reply = `# owner/repo — status ledger\n\n## Landmines\n${"- filler line padding the reply out past the cap.\n".repeat(120)}`;
			while (Buffer.byteLength(reply, "utf8") > 4097) reply = reply.slice(0, -1);
			while (Buffer.byteLength(reply, "utf8") < 4097) reply += "x";
			expect(Buffer.byteLength(reply, "utf8")).toBe(4097);
			const { session } = makeSession(dir, makeSettings({ dir }), reply);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			expect(readFileSync(ledgerPath, "utf8")).toBe(INTACT);
		});

		it("REPAIRS a reply that drops a heading by splicing it back from the previous file", async () => {
			// Dropped-heading used to be the third refusal class, but the section
			// bytes are still in the previous file, so the sync writer splices the
			// lost section back (preserveHazards-style cut-and-paste) instead of
			// vetoing the whole write.
			const ledgerPath = seed();
			const noLandmines = "# owner/repo — status ledger\n\n## Current state\nRewritten whole, hazards gone.\n";
			const { session } = makeSession(dir, makeSettings({ dir }), noLandmines);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			const written = readFileSync(ledgerPath, "utf8");
			// The dropped section is restored VERBATIM and lands in its original
			// hazards-first slot; the model's rewrite of the surviving section
			// still lands too.
			expect(written).toContain("## Landmines\n- ⚠️ a standing constraint.");
			expect(written).toContain("## Current state\nRewritten whole, hazards gone.");
			expect(written.match(/^## .+$/m)?.[0]).toBe("## Landmines");
			expect(written.indexOf("## Landmines")).toBeLessThan(written.indexOf("## Current state"));
		});

		it("accepts a reply that REWORDS an annotated heading without dropping the section", async () => {
			// Live 2026-07-30: this repo's hazard heading is
			// "## Landmines (FIRST on purpose — see ovh-cloud #1201: ...)". Comparing raw
			// heading strings scored a reply saying plain "## Landmines" as dropping the
			// section, so the background writer could never write the file again even
			// though the section was present AND first. Rewording an annotation is not
			// losing a section.
			const ledgerPath = join(dir, "owner-repo.md");
			const annotated =
				"# owner/repo — status ledger\n\n## Landmines (FIRST on purpose — see ovh-cloud #1201)\n- ⚠️ a standing constraint.\n\n## Current state\nIntact.\n";
			writeFileSync(ledgerPath, annotated, "utf8");
			const reworded =
				"# owner/repo — status ledger\n\n## Landmines\n- ⚠️ a standing constraint.\n- ⚠️ a newly learned constraint.\n\n## Current state\nUpdated.\n";
			const { session } = makeSession(dir, makeSettings({ dir }), reworded);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			const written = readFileSync(ledgerPath, "utf8");
			expect(written).toContain("## Landmines\n");
			expect(written).toContain("- ⚠️ a standing constraint.");
			expect(written).toContain("- ⚠️ a newly learned constraint.");
			expect(written).toContain("Updated.");
		});

		it("RESTORES one of two same-key sections when a rewrite drops the other", async () => {
			// Key normalisation must not open a hole: "## Landmines" and
			// "## Landmines (infra)" collapse to the same key, so presence alone would
			// let one disappear silently. Counts, not a set — and the dropped
			// occurrence is spliced back VERBATIM from the previous file, in its
			// original slot, not merely detected.
			const ledgerPath = join(dir, "owner-repo.md");
			const twoSections =
				"# owner/repo — status ledger\n\n## Landmines\n- ⚠️ a standing constraint.\n\n## Landmines (infra)\n- ⚠️ an infra constraint.\n\n## Current state\nIntact.\n";
			writeFileSync(ledgerPath, twoSections, "utf8");
			const lostOne =
				"# owner/repo — status ledger\n\n## Landmines\n- ⚠️ a standing constraint.\n\n## Current state\nIntact.\n";
			const { session } = makeSession(dir, makeSettings({ dir }), lostOne);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			const written = readFileSync(ledgerPath, "utf8");
			expect(written).toContain("## Landmines (infra)\n- ⚠️ an infra constraint.");
			// The restored section sits between its same-key sibling and Current
			// state — the slot it was cut from.
			expect(written.indexOf("## Landmines\n")).toBeLessThan(written.indexOf("## Landmines (infra)"));
			expect(written.indexOf("## Landmines (infra)")).toBeLessThan(written.indexOf("## Current state"));
		});

		it("REPAIRS a wholesale rewrite that reorders hazards away from the first section", async () => {
			// All headings present, but Landmines reordered to the END. That used to
			// be refuse-only; the fix is cut-and-paste with in-memory data, so the
			// writer moves the hazard extent (byte-identical) back to the first '##'
			// slot — the positional rule agent-chat's ledger-guard enforces — and
			// still lands the rewrite. Enforced positionally, NOT by a byte budget:
			// the old byte-window form permanently froze any ledger whose hazards
			// legitimately grew past 4096 bytes.
			const ledgerPath = seed();
			const narrative = `${"- narrative bullet padding past the window.\n".repeat(160)}`;
			const reordered = `# owner/repo — status ledger\n\n## Current state\n${narrative}\n## Landmines\n- ⚠️ a standing constraint.\n`;
			expect(Buffer.byteLength(reordered, "utf8")).toBeGreaterThan(4096);
			const { session } = makeSession(dir, makeSettings({ dir }), reordered);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			const written = readFileSync(ledgerPath, "utf8");
			// Hazards are the first '##' section again, the moved body is
			// byte-identical (cut-and-paste, never a rewrite), and the model's
			// 160-bullet narrative survived the move.
			expect(written.match(/^## .+$/m)?.[0]).toBe("## Landmines");
			expect(written).toContain("## Landmines\n- ⚠️ a standing constraint.\n\n## Current state");
			expect(written.indexOf("## Landmines")).toBeLessThan(written.indexOf("## Current state"));
			expect(written.split("\n").filter(l => l.includes("narrative bullet padding")).length).toBe(160);
			expect(Buffer.byteLength(written, "utf8")).toBeGreaterThan(4096);
		});

		it("WRITES a hazards-first ledger whose hazard section runs past 4096 bytes", async () => {
			// The freeze this replaced: Family-Fun-Group-Husbandry_App.md's hazards end at
			// byte 7301, so the old byte-window predicate refused all 54 of its syncs while
			// each reported `done`. Hazards first + grown large is a NORMAL busy-repo state
			// and must persist ("do not contort a ledger to fit a margin").
			const ledgerPath = seed();
			const bigHazards = `# owner/repo — status ledger\n\n## Landmines\n- ⚠️ a standing constraint.\n${"- ⚠️ another load-bearing hazard that must persist.\n".repeat(120)}\n## Current state\nFine.\n`;
			expect(Buffer.byteLength(bigHazards, "utf8")).toBeGreaterThan(4096);
			const { session } = makeSession(dir, makeSettings({ dir }), bigHazards);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			const written = readFileSync(ledgerPath, "utf8");
			expect(written).not.toBe(INTACT);
			expect(Buffer.byteLength(written, "utf8")).toBeGreaterThan(4096);
			expect(written.split("\n").filter(l => l.includes("load-bearing hazard")).length).toBe(120);
		});

		it("reports a refused write as done with outcome 'refused' and the exact reason", async () => {
			// A refusal spends tokens and returns cleanly; before this the terminal event
			// was `done` with a cost attached and no indication the file was untouched.
			seed();
			const events: { phase: string; error?: string; outcome?: string; refuse_reason?: string }[] = [];
			const cut = "# owner/repo — status ledger\n\n## Landmines\n- ⚠️ a standing cons\n[…truncated]";
			const { session } = makeSession(dir, makeSettings({ dir }), cut);

			await maybeSync(session, "compaction", {
				resolveRepo: async () => "owner/repo",
				reportEvent: event =>
					events.push({
						phase: event.phase,
						error: event.error,
						outcome: event.outcome,
						refuse_reason: event.refuse_reason,
					}),
			});

			const terminal = events.at(-1);
			expect(terminal?.phase).toBe("done");
			expect(terminal?.outcome).toBe("refused");
			expect(terminal?.refuse_reason).toContain("truncation marker");
			expect(terminal?.error).toContain("ledger not written");
			expect(terminal?.error).toContain("truncation marker");
		});

		it("REPAIRS a rewrite that condenses hazards instead of vetoing the whole sync", async () => {
			const ledgerPath = seed();
			// Same heading, same position, VALID structure — but a load-bearing clause is
			// gone. Observed 07-29: a sync rewrite dropped Husbandry_App's search_path
			// re-arm trigger with every structural check green.
			// Refusing the WHOLE write was the old answer, and on a hazard-heavy ledger
			// it deadlocked: a model asked to summarise a repo condenses a long landmine
			// list every time, so the file could never be updated (agent-chat's own
			// ledger, live 2026-07-30: "hazard section shrank (5390 → 4143 bytes)").
			// Hazards now come from the previous file by construction, so the rest of
			// the ledger still gets its update and the hazard survives verbatim.
			const condensed =
				"# owner/repo — status ledger\n\n## Landmines\n- ⚠️ constraint.\n\n## Current state\nRewritten, hazard condensed.\n";
			const { session } = makeSession(dir, makeSettings({ dir }), condensed);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			const written = readFileSync(ledgerPath, "utf8");
			expect(written).toContain("- ⚠️ a standing constraint.");
			expect(written).toContain("Rewritten, hazard condensed.");
			expect(written).not.toContain("Intact.");
		});

		it("appends a genuinely new hazard while keeping every previous one", async () => {
			const ledgerPath = seed();
			const withNew =
				"# owner/repo — status ledger\n\n## Landmines\n- ⚠️ a brand new hazard learned this session.\n\n## Current state\nUpdated.\n";
			const { session } = makeSession(dir, makeSettings({ dir }), withNew);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			const written = readFileSync(ledgerPath, "utf8");
			expect(written).toContain("- ⚠️ a standing constraint.");
			expect(written).toContain("- ⚠️ a brand new hazard learned this session.");
			// Preserved first, appended after — order is the position invariant.
			expect(written.indexOf("a standing constraint")).toBeLessThan(written.indexOf("a brand new hazard"));
		});
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

	describe("Context Activity events (pause gate + reporting)", () => {
		function pausedSession(replyText = "# owner/repo — status ledger\n\n## Current state\nok."): {
			session: SessionContextSyncSession;
			calls: () => number;
		} {
			const state = { calls: 0 };
			const settings = makeSettings({ dir, controlFile: join(dir, "control.json") });
			const session: SessionContextSyncSession = {
				cwd: join(dir, "repo"),
				sessionId: "paused-session",
				sessionLabel: "Test session",
				transcriptPath: "/tmp/transcript.jsonl",
				settings: { getGroup: () => settings },
				messages: [{ role: "user" }],
				runEphemeralTurn: async () => {
					state.calls++;
					return { replyText };
				},
			};
			return { session, calls: () => state.calls };
		}

		it("controlFile {paused:true} skips before spending tokens, no runEphemeralTurn call", async () => {
			const { session, calls } = pausedSession();
			const settings = session.settings?.getGroup("sessionContextSync");
			if (!settings) throw new Error("expected settings");
			mkdirSync(join(dir, "repo"), { recursive: true });
			writeFileSync(settings.controlFile, JSON.stringify({ paused: true }));

			const events: Array<{ phase: string; error?: string }> = [];
			const resolveRepo = async () => "owner/repo";
			await maybeSync(session, "compaction", {
				resolveRepo,
				reportEvent: event => events.push({ phase: event.phase, error: event.error }),
			});

			expect(calls()).toBe(0);
			expect(events.map(e => e.phase)).toEqual(["skip"]);
			expect(events[0]?.error).toBe("paused");
		});

		it("missing/unreadable controlFile is treated as not-paused (never throws, sync proceeds)", async () => {
			mkdirSync(join(dir, "repo"), { recursive: true });
			const { session, calls } = pausedSession();
			const resolveRepo = async () => "owner/repo";

			await maybeSync(session, "compaction", { resolveRepo });

			expect(calls()).toBe(1);
			expect(existsSync(join(dir, "owner-repo.md"))).toBe(true);
		});

		it("emits start then done, correlated by the same activity id, with summed token usage", async () => {
			mkdirSync(join(dir, "repo"), { recursive: true });
			const state = { calls: 0 };
			const settings = makeSettings({ dir });
			const session: SessionContextSyncSession = {
				cwd: join(dir, "repo"),
				sessionId: "usage-session",
				settings: { getGroup: () => settings },
				messages: [{ role: "user" }],
				runEphemeralTurn: async () => {
					state.calls++;
					return {
						replyText: "# owner/repo — status ledger\n\n## Current state\nok.",
						assistantMessage: {
							usage: { input: 100, output: 40, cacheRead: 5 },
							model: "m",
							provider: "p",
							duration: 12,
						},
					};
				},
			};
			const resolveRepo = async () => "owner/repo";
			const events: Array<Record<string, unknown>> = [];

			await maybeSync(session, "idle", {
				resolveRepo,
				activityId: "fixed-id",
				reportEvent: event => events.push(event as unknown as Record<string, unknown>),
			});

			expect(events.map(e => e.phase)).toEqual(["start", "done"]);
			expect(events.every(e => e.id === "fixed-id")).toBe(true);
			expect(events.every(e => e.kind === "sync")).toBe(true);
			expect(events.every(e => e.trigger === "idle")).toBe(true);
			const done = events[1];
			expect(done.repos).toEqual(["owner-repo"]);
			expect(done.tokens_in).toBe(100);
			expect(done.tokens_out).toBe(40);
			expect(done.cache_read).toBe(5);
			expect(done.model).toBe("m");
			expect(done.provider).toBe("p");
			expect(done.duration_ms).toBe(12);
		});

		it("emits skip(disabled) without touching the network when sessionContextSync is off", async () => {
			const settings = makeSettings({ enabled: false, dir: "" });
			const session: SessionContextSyncSession = {
				cwd: dir,
				sessionId: "disabled-session",
				settings: { getGroup: () => settings },
				messages: [{ role: "user" }],
				runEphemeralTurn: async () => ({ replyText: "" }),
			};
			const events: Array<{ phase: string; error?: string }> = [];

			await maybeSync(session, "idle", {
				reportEvent: event => events.push({ phase: event.phase, error: event.error }),
			});

			expect(events).toEqual([{ phase: "skip", error: "disabled" }]);
		});

		it("the default HTTP reporter never touches the network for a disabled session (no deps.reportEvent override)", async () => {
			// Regression: `reportUrl` defaults to a non-empty localhost URL even
			// though `enabled` defaults to false. Without an explicit
			// `deps.reportEvent` (i.e. the automatic idle/compaction/dispose call
			// sites, not the `sync-context` CLI), a disabled session must stay a
			// true no-op — no fetch to agent-chat's default endpoint.
			const settings = makeSettings({ enabled: false, dir: "", reportUrl: "http://127.0.0.1:8811" });
			const session: SessionContextSyncSession = {
				cwd: dir,
				sessionId: "disabled-session-live-reporturl",
				settings: { getGroup: () => settings },
				messages: [{ role: "user" }],
				runEphemeralTurn: async () => ({ replyText: "" }),
			};
			const fetchSpy = spyOn(globalThis, "fetch");
			try {
				await maybeSync(session, "idle", {});
				expect(fetchSpy).not.toHaveBeenCalled();
			} finally {
				fetchSpy.mockRestore();
			}
		});
	});
});
