import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core";
import { INDEX_LINE_MAX_CHARS, RAW_MEMORY_TYPE, RAW_SOURCE, WikiStore } from "../wiki";
import {
	type Complete,
	checkPatternBody,
	gateProposal,
	parseMaintainerOutput,
	runWikiMaintainerPass,
	sampleRows,
	truncateContent,
} from "../wiki-maintainer";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SLUG = "deploy-success-not-live";

/** A file-backed bank with one raw transcript row per session, each retained by that session's own handle. */
function bankWithRaw(sessions: string[]): { memory: Mnemopi; rawIds: string[]; dbPath: string } {
	const dir = mkdtempSync(path.join(tmpdir(), "loom-wiki-maint-test-"));
	tempDirs.push(dir);
	const dbPath = path.join(dir, "mnemopi.db");
	const rawIds = sessions.map((sessionId, i) =>
		addRaw(dbPath, sessionId, `transcript ${i}: the deploy said success but the container was never replaced`),
	);
	return { memory: new Mnemopi({ dbPath, sessionId: "lane-a", bank: "testbank" }), rawIds, dbPath };
}

function addRaw(dbPath: string, sessionId: string, content: string): string {
	const lane = new Mnemopi({ dbPath, sessionId, bank: "testbank" });
	const id = lane.remember(content, { source: RAW_SOURCE, memoryType: RAW_MEMORY_TYPE, importance: 0.5 });
	lane.close();
	return id;
}

/**
 * `working_memory.created_at` is `DEFAULT CURRENT_TIMESTAMP` — second
 * resolution — and `rawRowsSince` compares with `>`, so a row retained in the
 * same second as the last log row is invisible to the next pass. Tests that
 * need "a row that arrived after the pass" date it forward explicitly.
 */
function dateForward(memory: Mnemopi, id: string, seconds: number): void {
	memory.db.run(`UPDATE working_memory SET created_at = datetime(created_at, '+${seconds} seconds') WHERE id = ?`, [
		id,
	]);
}

function rowCount(memory: Mnemopi): number {
	// bun:sqlite returns untyped rows; the query names exactly one integer column.
	const row = memory.db.query("SELECT count(*) AS n FROM working_memory").get() as { n: number };
	return row.n;
}

function scripted(responses: Array<string | null>): { complete: Complete; calls: string[] } {
	const calls: string[] = [];
	const complete: Complete = async prompt => {
		calls.push(prompt);
		return responses.length > 0 ? (responses.shift() ?? null) : null;
	};
	return { complete, calls };
}

function validBody(evidence: readonly string[]): string {
	return [
		"PROBLEM: deploy says success, old container serves ROOT CAUSE: reused image tag FIX: check container ctime after deploy",
		"",
		"## Symptoms",
		"The deploy command reports success but the old code keeps answering requests.",
		"## Root cause",
		"The image tag was reused, so the runtime saw no change and kept the running container.",
		"## Fix",
		"Compare the container's created timestamp with the deploy time; redeploy with a unique tag when they disagree.",
		"## Evidence",
		...evidence.map(id => `- raw:${id}: "the deploy said success but the container was never replaced"`),
	].join("\n");
}

function createOutput(evidence: readonly string[], slug = SLUG, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		summary: "one recurring deploy failure",
		proposals: [{ kind: "create", slug, body: validBody(evidence), evidence }],
		refuted: [],
		...extra,
	});
}

const ACCEPT = JSON.stringify({ accept: true, reason: "grounded, root-caused, actionable" });

describe("runWikiMaintainerPass", () => {
	it("skips with no-llm and writes nothing when the bank has no LLM and none is injected", async () => {
		const { memory } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const before = rowCount(memory);
		expect(memory.llmEnabled).toBe(false);
		expect(await runWikiMaintainerPass(store)).toEqual({
			skipped: "no-llm",
			sampled: [],
			accepted: 0,
			rejected: 0,
			errors: [],
		});
		expect(rowCount(memory)).toBe(before);
		memory.close();
	});

	it("skips with no-new-rows without a log row and without calling the model", async () => {
		const { memory } = bankWithRaw([]);
		const store = new WikiStore("testbank", memory);
		const fake = scripted([]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result.skipped).toBe("no-new-rows");
		expect(fake.calls).toHaveLength(0);
		expect(store.listLog()).toHaveLength(0);
		memory.close();
	});

	it("lands an evidenced create as a pattern row and logs it ACCEPTED", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		const fake = scripted([createOutput(rawIds), ACCEPT]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result).toMatchObject({ accepted: 1, rejected: 0, errors: [] });
		expect(result.sampled.sort()).toEqual([...rawIds].sort());
		expect(fake.calls).toHaveLength(2);
		// The maintainer prompt carried the sampled rows and the index; the judge prompt carried the body.
		expect(fake.calls[0]).toContain(`raw:${rawIds[0]}`);
		expect(fake.calls[0]).toContain("(no patterns yet)");
		expect(fake.calls[1]).toContain("## Root cause");
		const pattern = store.getPattern(SLUG);
		expect(pattern?.evidence.sort()).toEqual([...rawIds].sort());
		expect(pattern?.sessions).toEqual(["lane-a", "lane-b"]);
		const log = store.listLog();
		expect(log).toHaveLength(1);
		expect(log[0]?.decisions).toEqual([
			{ kind: "create", slug: SLUG, decision: "accepted", reason: "grounded, root-caused, actionable" },
		]);
		expect(log[0]?.summary).toContain(`ACCEPTED create \`${SLUG}\``);
		memory.close();
	});

	it("rejects a create citing a nonexistent raw id before the judge and writes no pattern", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const fake = scripted([createOutput([rawIds[0]!, "raw-does-not-exist"]), ACCEPT]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result).toMatchObject({ accepted: 0, rejected: 1 });
		expect(fake.calls).toHaveLength(1);
		expect(store.listPatterns()).toHaveLength(0);
		expect(store.listLog()[0]?.decisions[0]).toMatchObject({
			decision: "rejected",
			reason: "evidence raw-does-not-exist is not a raw row",
		});
		memory.close();
	});

	it("rejects a slug already rejected on the same sessions without calling the judge", async () => {
		const { memory, rawIds, dbPath } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		store.appendLog({
			at: new Date().toISOString(),
			sampled: rawIds,
			summary: "earlier pass",
			decisions: [{ kind: "create", slug: SLUG, decision: "rejected", reason: "judge: symptom only" }],
		});
		const again = addRaw(
			dbPath,
			"lane-a",
			"lane-a again: deploy said success, container not replaced, root cause unclear",
		);
		dateForward(memory, again, 10);
		const fake = scripted([createOutput([again]), ACCEPT]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result).toMatchObject({ sampled: [again], accepted: 0, rejected: 1 });
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toContain(`- ${SLUG}: judge: symptom only`);
		expect(store.listPatterns()).toHaveLength(0);
		// Both log rows share a second-resolution created_at, so pick the pass's own by its sampled set.
		const passLog = store.listLog().find(entry => entry.sampled[0] === again);
		expect(passLog?.decisions[0]?.reason).toContain("no evidence from a new session");
		memory.close();
	});

	it("lets a rejected slug through once a session the rejecting pass never saw evidences it", async () => {
		const { memory, rawIds, dbPath } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		store.appendLog({
			at: new Date().toISOString(),
			sampled: rawIds,
			summary: "earlier pass",
			decisions: [{ kind: "create", slug: SLUG, decision: "rejected", reason: "judge: symptom only" }],
		});
		const other = addRaw(
			dbPath,
			"lane-c",
			"lane-c: deploy said success, container not replaced — image tag was reused",
		);
		dateForward(memory, other, 10);
		const fake = scripted([createOutput([other]), ACCEPT]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result).toMatchObject({ accepted: 1, rejected: 0 });
		expect(fake.calls).toHaveLength(2);
		expect(store.getPattern(SLUG)?.sessions).toEqual(["lane-c"]);
		memory.close();
	});

	it("records a judge rejection with the judge's reason and writes no pattern", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const fake = scripted([
			createOutput(rawIds),
			JSON.stringify({ accept: false, reason: "names a symptom, not a cause" }),
		]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result).toMatchObject({ accepted: 0, rejected: 1 });
		expect(fake.calls).toHaveLength(2);
		expect(store.listPatterns()).toHaveLength(0);
		expect(store.listLog()[0]?.decisions[0]).toEqual({
			kind: "create",
			slug: SLUG,
			decision: "rejected",
			reason: "judge: names a symptom, not a cause",
		});
		memory.close();
	});

	it("rejects an update whose target is missing and leaves the pattern body unchanged", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		const original = store.createPattern({ slug: SLUG, body: validBody([rawIds[0]!]), evidence: [rawIds[0]!] });
		const fake = scripted([
			JSON.stringify({
				summary: "extend",
				proposals: [
					{
						kind: "update",
						slug: SLUG,
						edits: [{ op: "replace", target: "this text is not in the body", content: "x" }],
						evidence: [rawIds[1]],
					},
				],
			}),
			ACCEPT,
		]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result).toMatchObject({ accepted: 0, rejected: 1 });
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]).toContain(`### ${SLUG} (version 1`);
		const after = store.getPattern(SLUG);
		expect(after?.body).toBe(original.body);
		expect(after?.version).toBe(1);
		expect(store.listLog()[0]?.decisions[0]?.reason).toContain("patch failed: op 0: target not found");
		memory.close();
	});

	it("applies a well-formed update, merging evidence and bumping the version", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: SLUG, body: validBody([rawIds[0]!]), evidence: [rawIds[0]!] });
		const fake = scripted([
			JSON.stringify({
				summary: "extend",
				proposals: [
					{
						kind: "update",
						slug: SLUG,
						edits: [{ op: "append", content: `- raw:${rawIds[1]}: same failure from lane-b` }],
						evidence: [rawIds[1]],
					},
				],
			}),
			ACCEPT,
		]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result).toMatchObject({ accepted: 1, rejected: 0 });
		const after = store.getPattern(SLUG);
		expect(after?.version).toBe(2);
		expect(after?.body.endsWith(`- raw:${rawIds[1]}: same failure from lane-b`)).toBe(true);
		expect(after?.sessions).toEqual(["lane-a", "lane-b"]);
		memory.close();
	});

	it("writes nothing for malformed model output so the rows are sampled again next pass", async () => {
		const { memory } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const before = rowCount(memory);
		const fake = scripted(["Sure! Here are my thoughts, no JSON though."]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result.skipped).toBe("malformed-output");
		expect(result.sampled).toHaveLength(1);
		expect(rowCount(memory)).toBe(before);
		expect(store.listLog()).toHaveLength(0);
		expect(store.lastPassAt()).toBeNull();
		// A retry sees the same rows.
		const retry = await runWikiMaintainerPass(store, { complete: scripted([null]).complete });
		expect(retry.sampled).toEqual(result.sampled);
		memory.close();
	});

	it("treats a null completion as malformed output", async () => {
		const { memory } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const result = await runWikiMaintainerPass(store, { complete: scripted([null]).complete });
		expect(result.skipped).toBe("malformed-output");
		expect(store.listLog()).toHaveLength(0);
		memory.close();
	});

	it("turns a thrown model call into an errors entry without consuming the rows", async () => {
		const { memory } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const result = await runWikiMaintainerPass(store, {
			complete: async () => {
				throw new Error("upstream 503");
			},
		});
		expect(result.errors).toEqual(["Error: upstream 503"]);
		expect(result.skipped).toBeUndefined();
		expect(store.listLog()).toHaveLength(0);
		memory.close();
	});

	it("samples only raw rows newer than the last pass on the second run", async () => {
		const { memory, rawIds, dbPath } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		const first = await runWikiMaintainerPass(store, { complete: scripted([createOutput(rawIds), ACCEPT]).complete });
		expect(first.accepted).toBe(1);
		const later = addRaw(dbPath, "lane-c", "lane-c: something else failed entirely");
		dateForward(memory, later, 10);
		const fake = scripted([JSON.stringify({ summary: "nothing worth keeping", proposals: [], refuted: [] })]);
		const second = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(second).toEqual({ sampled: [later], accepted: 0, rejected: 0, errors: [] });
		expect(fake.calls[0]).not.toContain(`--- raw:${rawIds[0]}`);
		expect(fake.calls[0]).toContain(`--- raw:${later}`);
		expect(fake.calls[0]).toContain(`### ${SLUG} (version 1`);
		expect(store.listLog()).toHaveLength(2);
		memory.close();
	});

	it("applies a refutation by superseding the raw row, which then leaves rawRowsSince", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-a-2"]);
		const store = new WikiStore("testbank", memory);
		// The fixture's handle is lane-a, and `invalidate` is session-scoped, so only the lane-a row can be refuted from it.
		const fake = scripted([
			createOutput(rawIds, SLUG, {
				refuted: [
					{ rawId: rawIds[0], bySlug: SLUG, reason: "claimed a restart fixes it; the pattern shows it does not" },
					{ rawId: "nope", bySlug: SLUG, reason: "not sampled" },
				],
			}),
			ACCEPT,
		]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result.accepted).toBe(1);
		expect(store.rawRowsSince(null).map(r => r.id)).toEqual([rawIds[1]]);
		expect(store.rawRowExists(rawIds[0]!)).toBe(true);
		const superseded = memory.db.query("SELECT superseded_by FROM working_memory WHERE id = ?").get(rawIds[0]!) as {
			superseded_by: string;
		};
		expect(superseded.superseded_by).toBe(store.getPattern(SLUG)?.id ?? "");
		const summary = store.listLog()[0]?.summary ?? "";
		expect(summary).toContain(`refuted raw:${rawIds[0]}`);
		expect(summary).toContain("skipped refutation of raw:nope: not sampled");
		memory.close();
	});

	it("enforces the per-pass create cap as a rejection, not an error", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const proposals = ["a", "b", "c", "d"].map(s => ({
			kind: "create",
			slug: `pattern-${s}`,
			body: validBody(rawIds),
			evidence: rawIds,
		}));
		const fake = scripted([JSON.stringify({ summary: "many", proposals }), ACCEPT, ACCEPT, ACCEPT, ACCEPT]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete });
		expect(result).toMatchObject({ accepted: 3, rejected: 1 });
		// Three judge calls: the fourth proposal is capped before the judge.
		expect(fake.calls).toHaveLength(4);
		expect(store.listLog()[0]?.decisions[3]).toMatchObject({
			slug: "pattern-d",
			decision: "rejected",
			reason: "pass cap",
		});
		memory.close();
	});

	it("dryRun runs the gate but writes nothing", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const before = rowCount(memory);
		const fake = scripted([createOutput(rawIds), ACCEPT]);
		const result = await runWikiMaintainerPass(store, { complete: fake.complete, dryRun: true });
		expect(result).toMatchObject({ accepted: 1, rejected: 0 });
		expect(fake.calls).toHaveLength(2);
		expect(rowCount(memory)).toBe(before);
		expect(store.lastPassAt()).toBeNull();
		memory.close();
	});
});

describe("gateProposal", () => {
	function contextFor(
		store: WikiStore,
		judge: Complete,
		rejected: Array<{ slug: string; reason: string; at: string; sessions: Set<string> }> = [],
	) {
		const sampled = new Map(store.rawRowsSince(null).map(row => [row.id, row] as const));
		return { sampled, rejected, applied: { creates: 0, updates: 0 }, index: store.renderIndex(), judge };
	}

	it("names the invariant that failed, in order, and only reaches the judge when all hold", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const judge = scripted([ACCEPT, ACCEPT]);
		const ctx = contextFor(store, judge.complete);
		const body = validBody(rawIds);

		expect(await gateProposal(store, { kind: "create", slug: "x", body, evidence: [] }, ctx)).toEqual({
			ok: false,
			reason: "no evidence cited",
		});
		expect(await gateProposal(store, { kind: "create", slug: "", body, evidence: rawIds }, ctx)).toEqual({
			ok: false,
			reason: "empty slug",
		});
		expect(
			await gateProposal(
				store,
				{ kind: "create", slug: "x", body: `PROBLEM: p ROOT CAUSE: c\n${body}`, evidence: rawIds },
				ctx,
			),
		).toEqual({
			ok: false,
			reason: "index line lacks FIX",
		});
		expect(
			await gateProposal(
				store,
				{
					kind: "create",
					slug: "x",
					body: `${"PROBLEM: ".padEnd(INDEX_LINE_MAX_CHARS - 10, "x")} ROOT CAUSE: c FIX: f\n${body}`,
					evidence: rawIds,
				},
				ctx,
			),
		).toEqual({
			ok: false,
			reason: `index line is ${INDEX_LINE_MAX_CHARS + 11} chars (max ${INDEX_LINE_MAX_CHARS})`,
		});
		expect(
			await gateProposal(
				store,
				{
					kind: "create",
					slug: "x",
					body: "PROBLEM: p ROOT CAUSE: c FIX: f\n## Evidence\n- raw",
					evidence: rawIds,
				},
				ctx,
			),
		).toEqual({
			ok: false,
			reason: "body is 49 chars (min 200)",
		});
		expect(
			await gateProposal(
				store,
				{ kind: "create", slug: "x", body: body.replace("## Evidence", "## Sources"), evidence: rawIds },
				ctx,
			),
		).toEqual({
			ok: false,
			reason: "body lacks an ## Evidence section",
		});
		expect(
			await gateProposal(
				store,
				{ kind: "update", slug: "missing", edits: [{ op: "append", content: "x" }], evidence: rawIds },
				ctx,
			),
		).toEqual({
			ok: false,
			reason: "unknown pattern 'missing'; propose create",
		});
		expect(judge.calls).toHaveLength(0);

		const ok = await gateProposal(
			store,
			{ kind: "create", slug: "Deploy Success != Live", body, evidence: rawIds },
			ctx,
		);
		expect(ok).toEqual({ ok: true, slug: "deploy-success-live", body, reason: "grounded, root-caused, actionable" });
		expect(judge.calls).toHaveLength(1);

		store.createPattern({ slug: "deploy-success-live", body, evidence: rawIds });
		expect(
			await gateProposal(store, { kind: "create", slug: "deploy-success-live", body, evidence: rawIds }, ctx),
		).toEqual({
			ok: false,
			reason: "exists; propose update",
		});
		memory.close();
	});

	it("rejects an unparseable judge answer rather than guessing", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		const ctx = contextFor(store, scripted(["I think it is fine"]).complete);
		expect(
			await gateProposal(store, { kind: "create", slug: "x", body: validBody(rawIds), evidence: rawIds }, ctx),
		).toEqual({
			ok: false,
			reason: "judge unparseable",
		});
		memory.close();
	});
});

describe("helpers", () => {
	it("sampleRows prefers friction rows, fills with the newest, and keeps chronological order", () => {
		const row = (id: string, content: string) => ({ id, content, sessionId: "s", createdAt: id, metadata: {} });
		const rows = [
			row("1", "routine"),
			row("2", "an ERROR happened"),
			row("3", "routine"),
			row("4", "the root cause was"),
			row("5", "routine"),
		];
		expect(sampleRows(rows, 3).map(r => r.id)).toEqual(["2", "4", "5"]);
		expect(sampleRows(rows, 10).map(r => r.id)).toEqual(["1", "2", "3", "4", "5"]);
	});

	it("truncateContent keeps head and tail in a 2:1 split with an elision marker", () => {
		const text = "a".repeat(100) + "b".repeat(100);
		expect(truncateContent(text, 300)).toBe(text);
		const cut = truncateContent(text, 30);
		expect(cut.startsWith("a".repeat(20))).toBe(true);
		expect(cut.endsWith("b".repeat(10))).toBe(true);
		expect(cut).toContain("[... 170 chars elided ...]");
	});

	it("parseMaintainerOutput strips fences, tolerates prose around the JSON, and isolates bad proposals", () => {
		const parsed = parseMaintainerOutput(
			'Here you go:\n```json\n{"summary":"s","proposals":[{"kind":"create","slug":"a","body":"b","evidence":["r"]},{"kind":"update","slug":"u","edits":[{"op":"bogus"}],"evidence":["r"]},{"kind":"weird"}],"refuted":[{"rawId":"r","bySlug":"a"},{"rawId":1}]}\n```\nDone.',
		);
		expect(parsed?.summary).toBe("s");
		expect(parsed?.proposals[0]).toEqual({ kind: "create", slug: "a", body: "b", evidence: ["r"] });
		expect(parsed?.proposals[1]).toMatchObject({ kind: "invalid", slug: "u", logKind: "update" });
		expect(parsed?.proposals[2]).toMatchObject({ kind: "invalid", slug: "(no slug)", logKind: "create" });
		expect(parsed?.refuted).toEqual([{ rawId: "r", bySlug: "a", reason: "" }]);
		expect(parseMaintainerOutput('{"summary":"s","proposals":"nope"}')).toBeNull();
		expect(parseMaintainerOutput("[]")).toBeNull();
		expect(parseMaintainerOutput(null)).toBeNull();
	});

	it("parseMaintainerOutput accepts evidence ids cited with the prompt's raw: label", () => {
		// Live smol model behaviour: every id came back as "raw:<id>".
		const parsed = parseMaintainerOutput(
			'{"summary":"s","proposals":[{"kind":"create","slug":"a","body":"b","evidence":["raw:abc"," raw:def ","ghi"]}],"refuted":[{"rawId":"raw:abc","bySlug":"a"}]}',
		);
		expect(parsed?.proposals[0]).toMatchObject({ evidence: ["abc", "def", "ghi"] });
		expect(parsed?.refuted[0]?.rawId).toBe("abc");
	});

	it("checkPatternBody accepts a heading-marked index line and is case-insensitive on the parts", () => {
		expect(checkPatternBody(`# problem: p root cause: c fix: f\n${"x".repeat(200)}\n## Evidence`)).toBeNull();
	});
});
