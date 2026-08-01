/**
 * Contracts: `sync-context --repair` — the LLM-free on-disk ledger repair
 * (`repairLedgers` in commands/sync-context.ts, over session-context-sync's
 * real `repairLedgerOnDisk`).
 *
 * 1. Dry-run on a misplaced-hazards ledger: start + skip events with a
 *    "dry-run: would repair" note, the file is not written, summary ok.
 * 2. Apply on a misplaced-hazards ledger: the hazard block moves above every
 *    other "##" section with its content byte-identical, done event carries
 *    outcome "persisted", and the slug lands in `repaired`.
 * 3. Ambiguity (no hazards section): refused with the named reason,
 *    summary.ok is false (the exit-1 source), and the terminal event is
 *    `done` with outcome "refused" + refuse_reason (mirrors the sync path).
 * 4. A ledger carrying the truncation marker is refused with the guard's
 *    reason — marker-class damage is retry-only, never auto-repaired.
 * 5. "all" enumerates every ledger file in the dir (sorted, `_`-prefixed
 *    files like `_TEMPLATE.md` skipped).
 * 6. An explicit slug with no ledger file is a skip (nothing-to-do), not a
 *    refusal, and never reaches the repair function.
 * 7. A throwing repair lands in the refused lane with a `fail` event without
 *    stranding the remaining slugs.
 *
 * The event POST is stubbed by injecting a collector as `reportEvent` (the
 * fire-and-forget HTTP reporter is never constructed — reportUrl is "").
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LedgerRepairDeps, repairLedgers } from "@oh-my-pi/pi-coding-agent/commands/sync-context";
import type { ContextActivityEvent } from "@oh-my-pi/pi-coding-agent/utils/context-activity-reporter";

const MISPLACED = `# owner/repo — status ledger

## Current state
Intact.

## Landmines
- ⚠️ a standing constraint.
- ⚠️ a second constraint.

## Recent changes
- 2026-07-30 test: an entry.
`;

const NO_HAZARDS = `# owner/repo — status ledger

## Current state
No hazards section anywhere.

## Recent changes
- 2026-07-30 test: an entry.
`;

const MARKER_CUT = `# owner/repo — status ledger

## Landmines
- ⚠️ a standing cons
[…truncated]`;

interface Harness {
	events: ContextActivityEvent[];
	deps: LedgerRepairDeps;
}

function makeHarness(): Harness {
	const events: ContextActivityEvent[] = [];
	return {
		events,
		deps: {
			reportEvent: event => {
				events.push(event);
			},
		},
	};
}

function terminalEvents(events: ContextActivityEvent[]): ContextActivityEvent[] {
	return events.filter(event => event.phase !== "start");
}

describe("sync-context --repair", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sync-context-repair-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("dry-run computes the verdict, emits skip, and writes nothing", async () => {
		const ledgerPath = join(dir, "owner-repo.md");
		writeFileSync(ledgerPath, MISPLACED, "utf8");
		const { events, deps } = makeHarness();

		const summary = await repairLedgers(dir, "owner-repo", true, "", deps);

		expect(summary.ok).toBe(true);
		expect(summary.repaired).toEqual([]);
		expect(summary.refused).toEqual([]);
		expect(summary.skipped).toEqual([{ slug: "owner-repo", reason: "dry-run: would repair" }]);
		expect(readFileSync(ledgerPath, "utf8")).toBe(MISPLACED);

		expect(events.map(event => event.phase)).toEqual(["start", "skip"]);
		const skip = terminalEvents(events)[0];
		expect(skip.kind).toBe("repair");
		expect(skip.trigger).toBe("repair");
		expect(skip.session_id).toBe("ledger-repair");
		expect(skip.repos).toEqual(["owner-repo"]);
		expect(skip.error).toBe("dry-run: would repair");
		expect(skip.outcome).toBeUndefined();
	});

	it("applies a hazards-first block move and emits done + persisted", async () => {
		const ledgerPath = join(dir, "owner-repo.md");
		writeFileSync(ledgerPath, MISPLACED, "utf8");
		const { events, deps } = makeHarness();

		const summary = await repairLedgers(dir, "owner-repo", false, "", deps);

		expect(summary.ok).toBe(true);
		expect(summary.repaired).toEqual(["owner-repo"]);
		expect(summary.skipped).toEqual([]);
		expect(summary.refused).toEqual([]);

		const repaired = readFileSync(ledgerPath, "utf8");
		const firstSection = repaired.match(/^## .+$/m);
		expect(firstSection?.[0]).toBe("## Landmines");
		// The moved hazard block survives byte-identical — a reorder, never a rewrite.
		expect(repaired).toContain("- ⚠️ a standing constraint.\n- ⚠️ a second constraint.");
		expect(repaired).toContain("## Current state");
		expect(repaired).toContain("## Recent changes");

		expect(events.map(event => event.phase)).toEqual(["start", "done"]);
		const done = terminalEvents(events)[0];
		expect(done.outcome).toBe("persisted");
		expect(done.kind).toBe("repair");
		expect(done.session_id).toBe("ledger-repair");
	});

	it("refuses a ledger with no hazards section and fails the run", async () => {
		const ledgerPath = join(dir, "owner-repo.md");
		writeFileSync(ledgerPath, NO_HAZARDS, "utf8");
		const { events, deps } = makeHarness();

		const summary = await repairLedgers(dir, "owner-repo", false, "", deps);

		expect(summary.ok).toBe(false);
		expect(summary.repaired).toEqual([]);
		expect(summary.skipped).toEqual([]);
		expect(summary.refused).toEqual([{ slug: "owner-repo", reason: "no hazards section" }]);
		expect(readFileSync(ledgerPath, "utf8")).toBe(NO_HAZARDS);

		expect(events.map(event => event.phase)).toEqual(["start", "done"]);
		const done = terminalEvents(events)[0];
		expect(done.outcome).toBe("refused");
		expect(done.refuse_reason).toBe("no hazards section");
	});

	it("refuses a ledger carrying the truncation marker", async () => {
		const ledgerPath = join(dir, "owner-repo.md");
		writeFileSync(ledgerPath, MARKER_CUT, "utf8");
		const { events, deps } = makeHarness();

		const summary = await repairLedgers(dir, "owner-repo", false, "", deps);

		expect(summary.ok).toBe(false);
		expect(summary.refused).toEqual([{ slug: "owner-repo", reason: "carries the truncation marker" }]);
		expect(readFileSync(ledgerPath, "utf8")).toBe(MARKER_CUT);
		expect(terminalEvents(events)[0]?.outcome).toBe("refused");
	});

	it("'all' enumerates every ledger in the dir, sorted, skipping _-prefixed files", async () => {
		writeFileSync(join(dir, "b-repo.md"), NO_HAZARDS, "utf8");
		writeFileSync(join(dir, "a-repo.md"), MISPLACED, "utf8");
		writeFileSync(join(dir, "_TEMPLATE.md"), MISPLACED, "utf8");
		const { events, deps } = makeHarness();

		const summary = await repairLedgers(dir, "all", false, "", deps);

		const startedSlugs = events.filter(event => event.phase === "start").map(event => event.repos?.[0]);
		expect(startedSlugs).toEqual(["a-repo", "b-repo"]);
		expect(summary.repaired).toEqual(["a-repo"]);
		expect(summary.refused).toEqual([{ slug: "b-repo", reason: "no hazards section" }]);
		expect(summary.ok).toBe(false);
		// The template is untouched and never produced an event.
		expect(readFileSync(join(dir, "_TEMPLATE.md"), "utf8")).toBe(MISPLACED);
	});

	it("treats a missing ledger for an explicit slug as nothing-to-do", async () => {
		const { events, deps } = makeHarness();
		let repairCalls = 0;
		const counting: LedgerRepairDeps = {
			...deps,
			repairLedger: async () => {
				repairCalls++;
				return { repaired: false, reason: "unreachable" };
			},
		};

		const summary = await repairLedgers(dir, "ghost-repo", false, "", counting);

		expect(summary.ok).toBe(true);
		expect(summary.skipped.length).toBe(1);
		expect(summary.skipped[0]?.slug).toBe("ghost-repo");
		expect(summary.refused).toEqual([]);
		expect(repairCalls).toBe(0);
		expect(events.map(event => event.phase)).toEqual(["start", "skip"]);
	});

	it("a throwing repair lands in the refused lane without stranding siblings", async () => {
		writeFileSync(join(dir, "a-repo.md"), MISPLACED, "utf8");
		writeFileSync(join(dir, "b-repo.md"), MISPLACED, "utf8");
		const { events, deps } = makeHarness();
		const throwing: LedgerRepairDeps = {
			...deps,
			repairLedger: async ledgerPath => {
				if (ledgerPath.includes("a-repo")) throw new Error("disk on fire");
				return { repaired: true };
			},
		};

		const summary = await repairLedgers(dir, "all", false, "", throwing);

		expect(summary.ok).toBe(false);
		expect(summary.repaired).toEqual(["b-repo"]);
		expect(summary.refused.length).toBe(1);
		expect(summary.refused[0]?.slug).toBe("a-repo");
		expect(summary.refused[0]?.reason).toContain("disk on fire");
		expect(events.some(event => event.phase === "fail" && event.repos?.[0] === "a-repo")).toBe(true);
	});
});
