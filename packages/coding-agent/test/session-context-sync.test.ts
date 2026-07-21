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
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
