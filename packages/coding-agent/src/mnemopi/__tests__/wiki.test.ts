import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core";
import {
	applyPatchOps,
	PATTERN_MEMORY_TYPE,
	PATTERNS_SUBTREE,
	parsePatchOps,
	RAW_MEMORY_TYPE,
	RAW_SOURCE,
	splitIndexLine,
	WIKI_SESSION_ID,
	WikiStore,
} from "../wiki";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A file-backed bank with one raw transcript row per session, each retained by that session's own handle. */
function bankWithRaw(sessions: string[]): { memory: Mnemopi; rawIds: string[] } {
	const dir = mkdtempSync(path.join(tmpdir(), "loom-wiki-test-"));
	tempDirs.push(dir);
	const dbPath = path.join(dir, "mnemopi.db");
	const rawIds = sessions.map((sessionId, i) => {
		const lane = new Mnemopi({ dbPath, sessionId, bank: "testbank" });
		const id = lane.remember(`transcript ${i}: the deploy said success but the container was never replaced`, {
			source: RAW_SOURCE,
			memoryType: RAW_MEMORY_TYPE,
			importance: 0.5,
		});
		lane.close();
		return id;
	});
	return { memory: new Mnemopi({ dbPath, sessionId: "lane-a", bank: "testbank" }), rawIds };
}

describe("applyPatchOps", () => {
	it("applies append, replace and insert_after in order", () => {
		const r = applyPatchOps("a\nb\nc", [
			{ op: "replace", target: "b", content: "B" },
			{ op: "insert_after", target: "B", content: "b2" },
			{ op: "append", content: "d" },
		]);
		expect(r).toEqual({ ok: true, body: "a\nB\nb2\nc\nd" });
	});

	it("rejects a missing target and an ambiguous one, leaving the body untouched", () => {
		expect(applyPatchOps("x\ny", [{ op: "replace", target: "z", content: "q" }])).toMatchObject({ ok: false });
		expect(applyPatchOps("x\nx", [{ op: "replace", target: "x", content: "q" }])).toMatchObject({
			ok: false,
			error: expect.stringContaining("ambiguous"),
		});
	});

	it("parses model JSON edits and refuses malformed ones", () => {
		expect(
			parsePatchOps([
				{ op: "append", content: "z" },
				{ op: "replace", target: "a", content: "b" },
			]),
		).toHaveLength(2);
		expect(parsePatchOps([{ op: "replace", content: "b" }])).toBeNull();
		expect(parsePatchOps([{ op: "delete", target: "a", content: "" }])).toBeNull();
		expect(parsePatchOps("nope")).toBeNull();
	});
});

describe("WikiStore", () => {
	it("stores a pattern as a wiki-owned row under the patterns subtree, grounded in raw rows", () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		const pattern = store.createPattern({
			slug: "Deploy Success != Live.md",
			body: "PROBLEM deploy reports success while old container serves; ROOT CAUSE tag reuse; FIX compare container ctime.\n\nDetail.",
			evidence: rawIds,
		});
		expect(pattern.slug).toBe("deploy-success-live");
		expect(pattern.indexLine.startsWith("PROBLEM deploy reports success")).toBe(true);
		expect(pattern.sessions).toEqual(["lane-a", "lane-b"]);
		const row = memory.db
			.query("SELECT session_id, memory_type, metadata_json FROM working_memory WHERE id = ?")
			.get(pattern.id) as { session_id: string; memory_type: string; metadata_json: string };
		expect(row.session_id).toBe(WIKI_SESSION_ID);
		expect(row.memory_type).toBe(PATTERN_MEMORY_TYPE);
		expect(JSON.parse(row.metadata_json).subtree).toBe(PATTERNS_SUBTREE);
		expect(store.renderIndex()).toContain("[deploy-success-live](wiki/patterns/deploy-success-live.md)");
		memory.close();
	});

	it("updates a pattern in place across sessions, bumping version and merging evidence", () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b", "lane-c"]);
		const store = new WikiStore("testbank", memory);
		const p1 = store.createPattern({ slug: "p", body: "line one\nbody", evidence: [rawIds[0]!] });
		// A later pass runs from a different lane's Mnemopi handle on the same db.
		const later = new WikiStore("testbank", memory);
		const p2 = later.updatePattern("p", { body: "line one revised\nbody more", evidence: [rawIds[2]!] });
		expect(p2?.id).toBe(p1.id);
		expect(p2?.version).toBe(2);
		expect(p2?.evidence.sort()).toEqual([rawIds[0]!, rawIds[2]!].sort());
		expect(p2?.sessions).toEqual(["lane-a", "lane-c"]);
		expect(later.listPatterns()).toHaveLength(1);
		expect(later.updatePattern("missing", { body: "x", evidence: [] })).toBeUndefined();
		memory.close();
	});

	it("never edits the raw layer except to mark supersession, and hides superseded rows from the next pass", () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		expect(store.rawRowsSince(null).map(r => r.id)).toEqual(rawIds);
		const p = store.createPattern({ slug: "p", body: "idx\nbody", evidence: rawIds });
		// rawIds[1] was retained by lane-b; the store's handle is lane-a's.
		expect(store.supersedeRaw(rawIds[1]!, p.id)).toBe(true);
		expect(store.rawRowsSince(null).map(r => r.id)).toEqual([rawIds[0]]);
		expect(store.supersedeRaw(rawIds[1]!, p.id)).toBe(false);
		expect(store.supersedeRaw(p.id, p.id)).toBe(false);
		expect(store.listPatterns()).toHaveLength(1);
		expect(store.supersedeRaw(rawIds[0]!, p.id)).toBe(true);
		expect(store.rawRowExists(rawIds[0]!)).toBe(true);
		expect(store.rawRowExists("nope")).toBe(false);
		// Pattern rows are never mistaken for raw rows.
		expect(store.rawRowsSince(null).some(r => r.id === p.id)).toBe(false);
		memory.close();
	});

	it("keeps an audit trail: rejections are queryable and lastPassAt advances", () => {
		const { memory, rawIds } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		expect(store.lastPassAt()).toBeNull();
		store.appendLog({
			at: new Date().toISOString(),
			sampled: rawIds,
			summary: "first pass",
			decisions: [
				{ kind: "create", slug: "good", decision: "accepted", reason: "grounded" },
				{ kind: "create", slug: "vague", decision: "rejected", reason: "no root cause" },
			],
		});
		expect(store.lastPassAt()).not.toBeNull();
		expect(store.rejectedProposals()).toEqual([expect.objectContaining({ slug: "vague", reason: "no root cause" })]);
		expect(store.listLog()[0]?.summary).toContain("REJECTED create `vague`");
		store.appendSkillImpact({
			at: new Date().toISOString(),
			action: "create",
			skill: "deploy-verify",
			patterns: ["good"],
			diff: "--- a\n+++ b\n+line",
			decision: "accepted",
			reason: "recurs in 2 sessions",
		});
		const impact = store.listSkillImpact();
		expect(impact[0]).toMatchObject({
			action: "create",
			skill: "deploy-verify",
			patterns: ["good"],
			decision: "accepted",
			reason: "recurs in 2 sessions",
		});
		expect(impact[0]?.diff).toBe("--- a\n+++ b\n+line");
		expect(store.renderSkillImpact()).toContain("ACCEPTED create deploy-verify");
		memory.close();
	});

	it("splitIndexLine strips a heading marker and returns the remainder", () => {
		expect(splitIndexLine("# Title line\nrest\nmore")).toEqual({ indexLine: "Title line", rest: "rest\nmore" });
		expect(splitIndexLine("only")).toEqual({ indexLine: "only", rest: "" });
	});
});
