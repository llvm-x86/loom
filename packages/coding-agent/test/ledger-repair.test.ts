/**
 * Contracts: ledger self-repair — `remediateCandidate`, `validateLedgerCandidate`,
 * `repairLedgerOnDisk`, and the sync writer's retry-once.
 *
 * 1. `remediateCandidate` moves a misplaced hazard section to the first `##`
 *    slot with the body byte-identical (cut-and-paste, never a rewrite).
 * 2. `remediateCandidate` splices a dropped section back VERBATIM from the
 *    previous ledger, after the preceding surviving section.
 * 3. `remediateCandidate` never touches a cut-suspect candidate (truncation
 *    marker / cap boundary) — surgery would mask the signature the guard
 *    refuses on.
 * 4. `validateLedgerCandidate` keeps the exact legacy refusal reasons:
 *    marker, cap boundary, dropped headings, hazards-not-first, hazard
 *    shrinkage — and undefined for a clean candidate or a first-create.
 * 5. `repairLedgerOnDisk` repairs a hazards-not-first ledger in place.
 * 6. `repairLedgerOnDisk` refuses a ledger with no hazard section at all
 *    (ambiguity is the owner's call), leaving the file untouched.
 * 7. `repairLedgerOnDisk` dry-run computes the verdict but writes nothing.
 * 8. The sync writer retries a transient (marker) refusal exactly ONCE:
 *    succeeds when the retry is clean, refuses after the second bad reply,
 *    and never retries a third time.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	maybeSync,
	remediateCandidate,
	repairLedgerOnDisk,
	type SessionContextSyncSession,
	type SessionContextSyncSettings,
	validateLedgerCandidate,
} from "@oh-my-pi/pi-coding-agent/utils/session-context-sync";

const TITLE = "# owner/repo — status ledger";

function makeSettings(dir: string): SessionContextSyncSettings {
	return {
		enabled: true,
		dir,
		idleMinutes: 10,
		minIntervalSeconds: 120,
		workspaceRoot: "",
		spoolDir: "",
		controlFile: "",
		reportUrl: "",
	};
}

function makeQueueSession(
	cwd: string,
	settings: SessionContextSyncSettings,
	replies: string[],
): { session: SessionContextSyncSession; state: { calls: number } } {
	const state = { calls: 0 };
	const session: SessionContextSyncSession = {
		cwd,
		sessionId: "repair-test",
		settings: { getGroup: () => settings },
		messages: [{ role: "user" }] as unknown[],
		runEphemeralTurn: async () => {
			state.calls++;
			return { replyText: replies[Math.min(state.calls - 1, replies.length - 1)] ?? "" };
		},
	};
	return { session, state };
}

describe("ledger self-repair", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ledger-repair-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("remediateCandidate", () => {
		it("moves a misplaced hazard section to the first '##' slot, body byte-identical", () => {
			const hazardSection = "## ⚠️ Landmines\n- ⚠️ never do X.\n- ⚠️ never do Y.";
			const misplaced = `${TITLE}\n\n## Current state\nBusy.\n\n## Recent changes\n- 2026-07-31 sess: did things.\n\n${hazardSection}\n`;

			const result = remediateCandidate(misplaced, misplaced);

			expect(result.match(/^## .+$/m)?.[0]).toBe("## ⚠️ Landmines");
			// Cut-and-paste: the section is the exact same bytes, relocated — and
			// every other section survives in its original relative order.
			expect(result).toContain(`${hazardSection}\n\n## Current state`);
			expect(result.indexOf("## Current state")).toBeLessThan(result.indexOf("## Recent changes"));
			expect(result).toContain("## Current state\nBusy.");
			expect(result).toContain("## Recent changes\n- 2026-07-31 sess: did things.");
		});

		it("splices a dropped section back verbatim, after the preceding surviving section", () => {
			const previous = `${TITLE}\n\n## Landmines\n- ⚠️ a.\n\n## Current state\nOld.\n\n## In flight\n- task alpha.\n\n## Recent changes\n- entry.\n`;
			const candidate = `${TITLE}\n\n## Landmines\n- ⚠️ a.\n\n## Current state\nNew.\n\n## Recent changes\n- entry.\n`;

			const result = remediateCandidate(previous, candidate);

			// Restored VERBATIM, in the slot it was cut from — between Current
			// state and Recent changes — while the model's edit to Current state
			// still lands.
			expect(result).toContain("## In flight\n- task alpha.");
			expect(result).toContain("## Current state\nNew.");
			expect(result.indexOf("## Current state")).toBeLessThan(result.indexOf("## In flight"));
			expect(result.indexOf("## In flight")).toBeLessThan(result.indexOf("## Recent changes"));
		});

		it("restores a dropped HAZARD section into the first '##' slot", () => {
			const previous = `${TITLE}\n\n## Landmines\n- ⚠️ a standing constraint.\n\n## Current state\nIntact.\n`;
			const candidate = `${TITLE}\n\n## Current state\nRewritten, hazards gone.\n`;

			const result = remediateCandidate(previous, candidate);

			expect(result.match(/^## .+$/m)?.[0]).toBe("## Landmines");
			expect(result).toContain("## Landmines\n- ⚠️ a standing constraint.\n\n## Current state");
		});

		it("keeps a title preamble above the moved hazards (live defect: 3 ledgers)", () => {
			// Inserting directly after the title line displaced the preamble INTO
			// the moved hazard extent — the byte-identity assert refused all three
			// real ledgers with a preamble. The slot is before the first '##'.
			const preamble = "Running state of this repo/deploy. Read before working.";
			const previous = `${TITLE}\n\n${preamble}\n\n## Current state\nIntact.\n\n## Landmines\n- ⚠️ a standing constraint.\n`;
			const result = remediateCandidate(previous, previous);
			expect(result.indexOf(preamble)).toBeLessThan(result.indexOf("## Landmines"));
			expect(result.indexOf("## Landmines")).toBeLessThan(result.indexOf("## Current state"));
			const extent = result.match(/^## .+$/m);
			expect(extent?.[0]).toBe("## Landmines");
			expect(result).toContain("## Landmines\n- ⚠️ a standing constraint.\n\n## Current state");
		});

	it("never touches a cut-suspect candidate — surgery would mask the guard's signature", () => {
			// A spliced section landing AFTER a trailing truncation marker would move
			// the marker off the tail and let a cut ledger pass the guard.
			const previous = `${TITLE}\n\n## Landmines\n- ⚠️ a standing constraint.\n\n## Current state\nIntact.\n`;
			const cut = `${TITLE}\n\n## Landmines\n- ⚠️ a standing cons\n[…truncated]`;

			expect(remediateCandidate(previous, cut)).toBe(cut);
		});
	});

	describe("validateLedgerCandidate (legacy refusals unchanged)", () => {
		const intact = `${TITLE}\n\n## Landmines\n- ⚠️ a standing constraint.\n\n## Current state\nIntact.\n`;

		it("refuses the truncation marker, the cap boundary, dropped headings, hazards-not-first, and shrinkage", () => {
			expect(validateLedgerCandidate(intact, `${TITLE}\n\n## Landmines\n- ⚠️ cut\n[…truncated]`)).toBe(
				"carries the truncation marker",
			);

			const atCap = `${TITLE}\n\n## Landmines\n${"- filler line.\n".repeat(400)}\n\n## Current state\nIntact.\n`.slice(0, 4094);
			expect(validateLedgerCandidate(intact, atCap)).toBe(
				"lands exactly at the display-cap boundary (4096 bytes)",
			);

			expect(
				validateLedgerCandidate(intact, `${TITLE}\n\n## Landmines\n- ⚠️ a standing constraint.\n`),
			).toBe("drops 1 existing heading(s): ## Current state");

			expect(validateLedgerCandidate(intact, `${TITLE}\n\n## Current state\nIntact.\n\n## Landmines\n- ⚠️ a standing constraint.\n`)).toContain(
				"hazard section is not the first '##' section",
			);

			expect(
				validateLedgerCandidate(intact, `${TITLE}\n\n## Landmines\n- ⚠️ short.\n\n## Current state\nIntact.\n`),
			).toContain("hazard section shrank");
		});

		it("accepts a clean candidate, and a first-create with an empty previous", () => {
			expect(validateLedgerCandidate(intact, intact)).toBeUndefined();
			// previous === "" is the file-creation path: heading-drop and
			// hazard-shrinkage predicates vacuously pass.
			expect(validateLedgerCandidate("", `${TITLE}\n\n## Current state\nBrand new.\n`)).toBeUndefined();
		});
	});

	describe("repairLedgerOnDisk", () => {
		const misplaced = `${TITLE}\n\n## Current state\nBusy.\n\n## Recent changes\n- 2026-07-31 sess: did things.\n\n## ⚠️ Landmines\n- ⚠️ never do X.\n- ⚠️ never do Y.\n`;

		it("repairs a hazards-not-first ledger in place, hazard bytes identical", async () => {
			const ledgerPath = join(dir, "owner-repo.md");
			writeFileSync(ledgerPath, misplaced, "utf8");

			const result = await repairLedgerOnDisk(ledgerPath, { dryRun: false });

			expect(result).toEqual({ repaired: true });
			const written = readFileSync(ledgerPath, "utf8");
			expect(written.match(/^## .+$/m)?.[0]).toBe("## ⚠️ Landmines");
			expect(written).toContain("## ⚠️ Landmines\n- ⚠️ never do X.\n- ⚠️ never do Y.\n\n## Current state");
			expect(written).toContain("## Current state\nBusy.");
			expect(written).toContain("## Recent changes\n- 2026-07-31 sess: did things.");
		});

		it("refuses a ledger with no hazard section at all, leaving it untouched", async () => {
			const ledgerPath = join(dir, "owner-repo.md");
			const content = `${TITLE}\n\n## Current state\nFine.\n\n## Recent changes\n- entry.\n`;
			writeFileSync(ledgerPath, content, "utf8");

			const result = await repairLedgerOnDisk(ledgerPath, { dryRun: false });

			expect(result).toEqual({ repaired: false, reason: "no hazards section" });
			expect(readFileSync(ledgerPath, "utf8")).toBe(content);
		});

		it("dry-run reports the verdict but writes nothing", async () => {
			const ledgerPath = join(dir, "owner-repo.md");
			writeFileSync(ledgerPath, misplaced, "utf8");

			const result = await repairLedgerOnDisk(ledgerPath, { dryRun: true });

			expect(result).toEqual({ repaired: false, reason: "dry-run: would repair" });
			expect(readFileSync(ledgerPath, "utf8")).toBe(misplaced);
		});

		it("leaves an already-valid ledger alone", async () => {
			const ledgerPath = join(dir, "owner-repo.md");
			const content = `${TITLE}\n\n## ⚠️ Landmines\n- ⚠️ never do X.\n\n## Current state\nFine.\n`;
			writeFileSync(ledgerPath, content, "utf8");

			const result = await repairLedgerOnDisk(ledgerPath, { dryRun: false });

			expect(result).toEqual({ repaired: false, reason: "valid; nothing to repair" });
			expect(readFileSync(ledgerPath, "utf8")).toBe(content);
		});

		it("keeps a marker-carrying file refused with the named reason", async () => {
			const ledgerPath = join(dir, "owner-repo.md");
			const content = `${TITLE}\n\n## Landmines\n- ⚠️ cut short\n[…truncated]`;
			writeFileSync(ledgerPath, content, "utf8");

			const result = await repairLedgerOnDisk(ledgerPath, { dryRun: false });

			expect(result).toEqual({ repaired: false, reason: "carries the truncation marker" });
			expect(readFileSync(ledgerPath, "utf8")).toBe(content);
		});
	});

	describe("sync writer retry-once", () => {
		const intact = `${TITLE}\n\n## Landmines\n- ⚠️ a standing constraint.\n\n## Current state\nIntact.\n`;
		const markerReply = `${TITLE}\n\n## Landmines\n- ⚠️ a standing cons\n[…truncated]`;
		const cleanReply = `${TITLE}\n\n## Landmines\n- ⚠️ a standing constraint.\n\n## Current state\nUpdated after retry.\n`;

		it("retries a transient refusal exactly once and lands the clean retry", async () => {
			const ledgerPath = join(dir, "owner-repo.md");
			writeFileSync(ledgerPath, intact, "utf8");
			const { session, state } = makeQueueSession(dir, makeSettings(dir), [markerReply, cleanReply]);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			expect(state.calls).toBe(2);
			expect(readFileSync(ledgerPath, "utf8")).toContain("Updated after retry.");
		});

		it("refuses after the second bad reply — one retry, never two", async () => {
			const ledgerPath = join(dir, "owner-repo.md");
			writeFileSync(ledgerPath, intact, "utf8");
			const { session, state } = makeQueueSession(dir, makeSettings(dir), [markerReply]);

			await maybeSync(session, "compaction", { resolveRepo: async () => "owner/repo" });

			expect(state.calls).toBe(2);
			expect(readFileSync(ledgerPath, "utf8")).toBe(intact);
		});
	});
});
