/**
 * Wiki Maintainer pass (WikiSkill §3.2.2) with a taste gate in place of the
 * paper's validation-set score.
 *
 * One pass = one maintainer call that reads the index, the rejected list and
 * a bounded sample of raw rows, and answers STRICT JSON proposals; then, per
 * proposal, the hard invariants in `gateProposal` and ONE judge call. Every
 * verdict — rejections included — lands in a `wiki-log` row, which is what the
 * next pass reads so it does not re-propose the same slug (the paper's
 * ablation attributes the compounding to exactly this persistence).
 *
 * Why the gate is code first and model second: measured on this box's banks,
 * the raw rows average 295K chars and the models available for background
 * work are small. A judge that is asked "is this good?" about a page it cannot
 * verify against the transcript says yes. So the cheap checks that CAN be
 * verified mechanically — evidence ids exist and were actually shown to the
 * model, the index line fits the renderer's 140-char leaf summary, a patch
 * applies exactly once — run before the judge, and the judge only sees
 * proposals that already survived them.
 *
 * Nothing here throws: a pass returns a result object, and once sampling has
 * succeeded it always leaves a log row, even when the model call blew up.
 */
import {
	applyPatchOps,
	INDEX_LINE_MAX_CHARS,
	INDEX_LINE_TARGET_CHARS,
	type PatchOp,
	parsePatchOps,
	type RawRow,
	slugify,
	splitIndexLine,
	type WikiLogEntry,
	type WikiStore,
} from "./wiki";

export type Complete = (prompt: string, opts?: { maxTokens?: number; temperature?: number }) => Promise<string | null>;

export interface MaintainerPassOptions {
	/** LLM entry point; defaults to the bank's own `Mnemopi.complete`. Tests inject a fake. */
	complete?: Complete;
	now?: Date;
	/** Raw rows shown to the model per pass. */
	maxRows?: number;
	/** Per-row content budget; longer rows keep head + tail with an elision marker. */
	maxCharsPerRow?: number;
	/** Run the model and the gate but write nothing — no patterns, no supersession, no log row. */
	dryRun?: boolean;
}

export interface MaintainerPassResult {
	skipped?: "no-llm" | "no-new-rows" | "malformed-output";
	sampled: string[];
	accepted: number;
	rejected: number;
	errors: string[];
}

export type MaintainerProposal =
	| { kind: "create"; slug: string; body: string; evidence: string[] }
	| { kind: "update"; slug: string; edits: PatchOp[]; evidence: string[] };

export interface Refutation {
	rawId: string;
	bySlug: string;
	reason: string;
}

export interface MaintainerOutput {
	summary: string;
	proposals: Array<
		MaintainerProposal | { kind: "invalid"; slug: string; reason: string; logKind: "create" | "update" }
	>;
	refuted: Refutation[];
}

export interface GateContext {
	/** Raw rows shown to the model this pass, by id — the only ids a create may cite. */
	sampled: ReadonlyMap<string, RawRow>;
	/**
	 * Rejections from the last `REJECTION_LOOKBACK_PASSES` passes plus this
	 * pass's own, each with the sessions the rejecting pass had sampled.
	 */
	rejected: ReadonlyArray<PriorRejection>;
	/** Writes already made this pass. The caps bound writes, not attempts. */
	applied: { creates: number; updates: number };
	/** Current index, for the judge's "not contradicted" check. */
	index: string;
	judge: Complete;
}

export type GateVerdict = { ok: true; slug: string; body: string; reason: string } | { ok: false; reason: string };

export interface PriorRejection {
	slug: string;
	reason: string;
	at: string;
	/** Raw-row sessions the rejecting pass sampled — what "the same evidence" means. */
	sessions: ReadonlySet<string>;
}

/** Bounded edits per pass (paper: "bounded, auditable maintenance"). */
export const PASS_CAPS = { creates: 3, updates: 5, refutations: 5 } as const;
export const MIN_PATTERN_BODY_CHARS = 200;
/** How far back a rejected slug blocks re-proposal without evidence from a new session. */
export const REJECTION_LOOKBACK_PASSES = 10;
const DEFAULT_MAX_ROWS = 8;
const DEFAULT_MAX_CHARS_PER_ROW = 15_000;
/** Above this the prompt carries the index only; bodies would crowd out the raw rows. */
const FULL_BODY_PATTERN_LIMIT = 20;
/**
 * Sized for the caps below, not for what the model wants to say: a live
 * SkyRail pass produced 12 patterns of ~400 tokens each and was cut off at
 * 2000, which parses as nothing and loses the whole pass. Three creates plus
 * five updates at that size fit comfortably in 6000.
 */
const MAINTAINER_MAX_TOKENS = 6000;
const JUDGE_MAX_TOKENS = 400;
const TEMPERATURE = 0.2;
/** Evidence excerpt per cited row in the judge prompt. */
const JUDGE_EXCERPT_CHARS = 4000;
const RAW_ROW_QUERY_LIMIT = 200;

/**
 * Words that mark a transcript as containing friction. The paper's insight is
 * that failures, not successes, are where root causes get stated; a sample of
 * the newest N rows from a healthy lane is mostly routine work.
 */
const FRICTION_MARKERS = [
	"error",
	"fail",
	"wrong",
	"actually",
	"instead",
	"revert",
	"not working",
	"bug",
	"root cause",
	"fix",
] as const;

// ---- Sampling ----------------------------------------------------------------

function hasFriction(content: string): boolean {
	const lower = content.toLowerCase();
	return FRICTION_MARKERS.some(marker => lower.includes(marker));
}

/** Stratified pick: friction rows first (newest first), then fill with the newest rest. Keeps input order. */
export function sampleRows(rows: readonly RawRow[], maxRows: number): RawRow[] {
	const picked = new Set<RawRow>();
	for (let i = rows.length - 1; i >= 0 && picked.size < maxRows; i--) {
		const row = rows[i]!;
		if (hasFriction(row.content)) picked.add(row);
	}
	for (let i = rows.length - 1; i >= 0 && picked.size < maxRows; i--) picked.add(rows[i]!);
	return rows.filter(row => picked.has(row));
}

export function truncateContent(content: string, maxChars: number): string {
	if (content.length <= maxChars) return content;
	const head = Math.floor((maxChars * 2) / 3);
	const tail = maxChars - head;
	const elided = content.length - head - tail;
	return `${content.slice(0, head)}\n[... ${elided} chars elided ...]\n${content.slice(content.length - tail)}`;
}

// ---- Prompts -----------------------------------------------------------------

const BODY_RULES = `Pattern body rules:
- First line is the INDEX SENTENCE, no heading marker, ONE short sentence (aim for ${INDEX_LINE_TARGET_CHARS} characters; never more than ${INDEX_LINE_MAX_CHARS}) in the form: PROBLEM: <symptom> ROOT CAUSE: <cause> FIX: <what to do>
- Then the sections, in this order: ## Symptoms, ## Root cause, ## Fix, ## Evidence
- ## Evidence cites raw row ids (the "raw:<id>" labels below) and quotes the lines that support the claim
- One pattern per root cause. Two symptoms with one cause are one pattern.
- Prefer UPDATING an existing pattern over creating a near-duplicate; an update cites the slug from the index.
- Update edits use exact-substring targets that occur once in the current body.
- At most ${PASS_CAPS.creates} creates, ${PASS_CAPS.updates} updates and ${PASS_CAPS.refutations} refutations per answer; pick the most durable ones and leave the rest for a later pass (extras are rejected unread).
- Propose NOTHING if the rows contain nothing worth keeping. An empty proposals list is a good answer.`;

const OUTPUT_SCHEMA = `Answer with STRICT JSON only (no prose, no code fences):
{
  "summary": string,
  "proposals": [
    { "kind": "create", "slug": string, "body": string, "evidence": [rawId, ...] },
    { "kind": "update", "slug": string, "edits": [ {"op":"append","content":string} | {"op":"replace","target":string,"content":string} | {"op":"insert_after","target":string,"content":string} ], "evidence": [rawId, ...] }
  ],
  "refuted": [ { "rawId": string, "bySlug": string, "reason": string } ]
}
"refuted" lists raw rows whose claim an existing or proposed pattern shows to be WRONG (not merely covered); such rows are taken out of recall.`;

export function buildMaintainerPrompt(
	store: WikiStore,
	sampled: readonly RawRow[],
	rejected: ReadonlyArray<{ slug: string; reason: string; at: string }>,
	maxCharsPerRow: number,
): string {
	const patterns = store.listPatterns();
	const bodies =
		patterns.length > 0 && patterns.length <= FULL_BODY_PATTERN_LIMIT
			? patterns
					.map(p => `### ${p.slug} (version ${p.version}, evidence: ${p.evidence.join(", ")})\n${p.body}`)
					.join("\n\n")
			: "(index only)";
	const rejectedText =
		rejected.length === 0
			? "(none)"
			: rejected.map(r => `- ${r.slug}: ${r.reason} (${r.at.slice(0, 16)})`).join("\n");
	const rowsText = sampled
		.map(
			row =>
				`--- raw:${row.id} (session ${row.sessionId}, ${row.createdAt}) ---\n${truncateContent(row.content, maxCharsPerRow)}`,
		)
		.join("\n\n");
	return [
		"You are the wiki maintainer for a coding agent's memory bank. You read raw session transcripts and compile durable PATTERNS: one page per root-caused failure mode or proven strategy, each grounded in the transcripts that evidence it.",
		"",
		"## Current wiki index",
		store.renderIndex(),
		"",
		"## Existing pattern bodies (updatable by slug)",
		bodies,
		"",
		"## Previously rejected proposals — do NOT re-propose these slugs unless the rows below add genuinely new evidence",
		rejectedText,
		"",
		BODY_RULES,
		"",
		OUTPUT_SCHEMA,
		"",
		"## Raw rows sampled for this pass",
		rowsText,
	].join("\n");
}

function buildJudgePrompt(proposal: MaintainerProposal, slug: string, body: string, ctx: GateContext): string {
	const excerpts = proposal.evidence
		.map(id => {
			const row = ctx.sampled.get(id);
			return row
				? `--- raw:${id} (session ${row.sessionId}) ---\n${truncateContent(row.content, JUDGE_EXCERPT_CHARS)}`
				: `--- raw:${id} --- (already cited by this pattern; not shown)`;
		})
		.join("\n\n");
	const edits =
		proposal.kind === "update"
			? `\n## Proposed edits\n${proposal.edits.map(e => `- ${e.op}${"target" in e ? ` target=${JSON.stringify(e.target)}` : ""}: ${JSON.stringify(e.content)}`).join("\n")}\n`
			: "";
	return [
		"You are the taste gate for a coding agent's knowledge wiki. Judge ONE proposal against the cited evidence. Be strict: a pattern that is not grounded misleads every future session that reads it.",
		"",
		"## Current wiki index",
		ctx.index,
		"",
		`## Proposal: ${proposal.kind} \`${slug}\``,
		"### Resulting pattern body",
		body,
		edits,
		"## Cited evidence",
		excerpts,
		"",
		"## Rubric — accept only if ALL hold",
		"1. GROUNDED: the claims are supported at quote level by the cited evidence, not by general knowledge.",
		"2. ROOT CAUSE: the page states a cause, not just a symptom or a workaround.",
		"3. ACTIONABLE: the fix says what to do concretely enough to follow next time.",
		"4. CONSISTENT: it does not contradict an existing index entry (an update that corrects one is fine if the evidence shows the old entry was wrong).",
		"",
		'Answer with STRICT JSON only: {"accept": true|false, "reason": "<one sentence>"}',
	].join("\n");
}

// ---- Parsing -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip code fences, take the first `{` to the last `}`, parse. Null on anything else. */
export function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
	if (!text) return null;
	const stripped = text.replace(/```[a-zA-Z]*\n?/g, "");
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed: unknown = JSON.parse(stripped.slice(start, end + 1));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The prompt labels rows `raw:<id>` and the live smol model cites them that
 * way (measured: 12/12 proposals in a SkyRail pass carried the prefix and the
 * gate rejected every one as "not a raw row"). Accept both spellings.
 */
function rawIdOf(value: string): string {
	return value.startsWith("raw:") ? value.slice(4) : value;
}

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const v of value) {
		if (typeof v !== "string") return null;
		const id = rawIdOf(v.trim());
		if (id !== "") out.push(id);
	}
	return out;
}

/**
 * Top-level shape errors are a malformed pass (nothing is written except the
 * log). A single bad proposal inside a well-formed answer is rejected on its
 * own so the good ones beside it still land — that is not a partial write,
 * since each proposal is applied atomically or not at all.
 */
export function parseMaintainerOutput(text: string | null | undefined): MaintainerOutput | null {
	const obj = parseJsonObject(text);
	if (!obj) return null;
	if (obj.proposals !== undefined && !Array.isArray(obj.proposals)) return null;
	if (obj.refuted !== undefined && !Array.isArray(obj.refuted)) return null;
	const proposals: MaintainerOutput["proposals"] = [];
	for (const entry of Array.isArray(obj.proposals) ? obj.proposals : []) {
		const p = isRecord(entry) ? entry : {};
		const slug = typeof p.slug === "string" ? p.slug : "(no slug)";
		const logKind = p.kind === "update" ? "update" : "create";
		const evidence = stringArray(p.evidence);
		if (p.kind === "create") {
			if (typeof p.body !== "string" || !evidence) {
				proposals.push({
					kind: "invalid",
					slug,
					logKind,
					reason: "malformed proposal: create needs body and evidence[]",
				});
			} else proposals.push({ kind: "create", slug, body: p.body, evidence });
		} else if (p.kind === "update") {
			const edits = parsePatchOps(p.edits);
			if (!edits || edits.length === 0 || !evidence) {
				proposals.push({
					kind: "invalid",
					slug,
					logKind,
					reason: "malformed proposal: update needs edits[] and evidence[]",
				});
			} else proposals.push({ kind: "update", slug, edits, evidence });
		} else {
			proposals.push({
				kind: "invalid",
				slug,
				logKind,
				reason: `malformed proposal: unknown kind ${JSON.stringify(p.kind)}`,
			});
		}
	}
	const refuted: Refutation[] = [];
	for (const entry of Array.isArray(obj.refuted) ? obj.refuted : []) {
		if (!isRecord(entry) || typeof entry.rawId !== "string" || typeof entry.bySlug !== "string") continue;
		refuted.push({
			rawId: rawIdOf(entry.rawId.trim()),
			bySlug: entry.bySlug,
			reason: typeof entry.reason === "string" ? entry.reason : "",
		});
	}
	return { summary: typeof obj.summary === "string" ? obj.summary : "", proposals, refuted };
}

// ---- Gate --------------------------------------------------------------------

/** Null when the body satisfies the index-line and section rules, else the reason. */
export function checkPatternBody(body: string): string | null {
	const { indexLine } = splitIndexLine(body);
	if (indexLine.length > INDEX_LINE_MAX_CHARS) {
		return `index line is ${indexLine.length} chars (max ${INDEX_LINE_MAX_CHARS})`;
	}
	const upper = indexLine.toUpperCase();
	for (const part of ["PROBLEM", "ROOT CAUSE", "FIX"]) {
		if (!upper.includes(part)) return `index line lacks ${part}`;
	}
	if (body.length < MIN_PATTERN_BODY_CHARS) return `body is ${body.length} chars (min ${MIN_PATTERN_BODY_CHARS})`;
	if (!body.includes("## Evidence")) return "body lacks an ## Evidence section";
	return null;
}

function reject(reason: string): GateVerdict {
	return { ok: false, reason };
}

/**
 * Hard invariants in order, then the judge. Each rejection names the invariant
 * so the log — and the next maintainer prompt — says what was wrong.
 */
export async function gateProposal(
	store: WikiStore,
	proposal: MaintainerProposal,
	ctx: GateContext,
): Promise<GateVerdict> {
	const existing = proposal.kind === "update" ? store.getPattern(proposal.slug) : undefined;
	if (proposal.kind === "update" && !existing) return reject(`unknown pattern '${proposal.slug}'; propose create`);

	if (proposal.evidence.length === 0) return reject("no evidence cited");
	const alreadyCited = new Set(existing?.evidence ?? []);
	for (const id of proposal.evidence) {
		if (!store.rawRowExists(id)) return reject(`evidence ${id} is not a raw row`);
		if (!ctx.sampled.has(id) && !alreadyCited.has(id)) return reject(`evidence ${id} was not sampled this pass`);
	}

	let slug = proposal.slug;
	let body: string;
	if (proposal.kind === "create") {
		slug = slugify(proposal.slug);
		if (slug === "") return reject("empty slug");
		if (store.getPattern(slug)) return reject("exists; propose update");
		// A rejected slug comes back only on evidence from a SESSION the
		// rejecting pass had not seen. "Newer rows" cannot be the bar: every
		// pass samples strictly after the last log row, so every row is newer
		// than every earlier rejection and the check would never fire. A
		// second lane hitting the same thing is the recurrence the wiki is
		// for; the same lane hitting it again is the same story retold.
		const blocking = ctx.rejected.find(
			r =>
				slugify(r.slug) === slug &&
				!proposal.evidence.some(id => {
					const session = ctx.sampled.get(id)?.sessionId;
					return session !== undefined && !r.sessions.has(session);
				}),
		);
		if (blocking) {
			return reject(`rejected on ${blocking.at.slice(0, 16)} (${blocking.reason}); no evidence from a new session`);
		}
		body = proposal.body;
	} else {
		const patched = applyPatchOps(existing!.body, proposal.edits);
		if (!patched.ok) return reject(`patch failed: ${patched.error}`);
		body = patched.body;
	}

	const bodyIssue = checkPatternBody(body);
	if (bodyIssue) return reject(bodyIssue);

	if (proposal.kind === "create" && ctx.applied.creates >= PASS_CAPS.creates) return reject("pass cap");
	if (proposal.kind === "update" && ctx.applied.updates >= PASS_CAPS.updates) return reject("pass cap");

	const answer = parseJsonObject(
		await ctx.judge(buildJudgePrompt(proposal, slug, body, ctx), {
			maxTokens: JUDGE_MAX_TOKENS,
			temperature: TEMPERATURE,
		}),
	);
	if (!answer || typeof answer.accept !== "boolean") return reject("judge unparseable");
	const reason = typeof answer.reason === "string" && answer.reason.trim() !== "" ? answer.reason.trim() : "";
	if (!answer.accept) return reject(`judge: ${reason || "rejected without reason"}`);
	return { ok: true, slug, body, reason: reason || "accepted by judge" };
}

// ---- Pass --------------------------------------------------------------------

export async function runWikiMaintainerPass(
	store: WikiStore,
	options: MaintainerPassOptions = {},
): Promise<MaintainerPassResult> {
	const complete =
		options.complete ?? (store.memory.llmEnabled ? store.memory.complete.bind(store.memory) : undefined);
	if (!complete) return { skipped: "no-llm", sampled: [], accepted: 0, rejected: 0, errors: [] };

	const rows = store.rawRowsSince(store.lastPassAt(), RAW_ROW_QUERY_LIMIT);
	// No log row here on purpose: a scheduler that ticks on an idle bank
	// would otherwise fill wiki/log with empty passes.
	if (rows.length === 0) return { skipped: "no-new-rows", sampled: [], accepted: 0, rejected: 0, errors: [] };

	const now = options.now ?? new Date();
	const sampledRows = sampleRows(rows, options.maxRows ?? DEFAULT_MAX_ROWS);
	const sampled = new Map(sampledRows.map(row => [row.id, row] as const));
	const result: MaintainerPassResult = { sampled: [...sampled.keys()], accepted: 0, rejected: 0, errors: [] };
	const decisions: WikiLogEntry["decisions"] = [];
	let summary = "";
	const dryRun = options.dryRun === true;
	let logged = dryRun;
	// The log row is what advances `lastPassAt`, i.e. what consumes the
	// sampled rows. Until the model has produced a parseable answer nothing
	// has been learned from them, so a truncated reply or an upstream 503
	// must leave no row behind — the next pass simply samples them again.
	let answered = false;
	// Dry runs write nothing — a log row would advance `lastPassAt` and hide
	// the sampled rows from the next real pass.
	const writeLog = () => {
		if (dryRun) return;
		try {
			store.appendLog({ at: now.toISOString(), sampled: result.sampled, summary, decisions });
			logged = true;
		} catch (err) {
			result.errors.push(`appendLog: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const sessionsThisPass = new Set(sampledRows.map(row => row.sessionId));

	try {
		const rejected: PriorRejection[] = [];
		for (const entry of store.listLog(REJECTION_LOOKBACK_PASSES)) {
			const sessions = new Set(store.rawSessionsOf(entry.sampled));
			for (const d of entry.decisions) {
				if (d.decision === "rejected") rejected.push({ slug: d.slug, reason: d.reason, at: entry.at, sessions });
			}
		}
		const prompt = buildMaintainerPrompt(
			store,
			sampledRows,
			rejected,
			options.maxCharsPerRow ?? DEFAULT_MAX_CHARS_PER_ROW,
		);
		const parsed = parseMaintainerOutput(
			await complete(prompt, { maxTokens: MAINTAINER_MAX_TOKENS, temperature: TEMPERATURE }),
		);
		if (!parsed) {
			result.skipped = "malformed-output";
			return result;
		}
		answered = true;
		summary = parsed.summary;
		const ctx: GateContext = {
			sampled,
			rejected,
			applied: { creates: 0, updates: 0 },
			index: store.renderIndex(),
			judge: complete,
		};

		for (const proposal of parsed.proposals) {
			if (proposal.kind === "invalid") {
				decisions.push({
					kind: proposal.logKind,
					slug: proposal.slug,
					decision: "rejected",
					reason: proposal.reason,
				});
				result.rejected++;
				continue;
			}
			const verdict = await gateProposal(store, proposal, ctx);
			const logSlug = proposal.kind === "create" ? slugify(proposal.slug) || proposal.slug : proposal.slug;
			if (!verdict.ok) {
				decisions.push({ kind: proposal.kind, slug: logSlug, decision: "rejected", reason: verdict.reason });
				// Visible to the rest of this answer too, so a slug the judge
				// just turned down is not retried with the same rows.
				rejected.push({ slug: logSlug, reason: verdict.reason, at: now.toISOString(), sessions: sessionsThisPass });
				result.rejected++;
				continue;
			}
			// Applied immediately, not batched at the end: a later proposal in
			// the same answer may update or refute against the page just made,
			// and the caps count what actually landed.
			if (proposal.kind === "create") {
				if (!dryRun) store.createPattern({ slug: verdict.slug, body: verdict.body, evidence: proposal.evidence });
				ctx.applied.creates++;
			} else {
				if (!dryRun && !store.updatePattern(verdict.slug, { body: verdict.body, evidence: proposal.evidence })) {
					decisions.push({ kind: "update", slug: logSlug, decision: "rejected", reason: "update did not store" });
					result.rejected++;
					continue;
				}
				ctx.applied.updates++;
			}
			// The index the judge sees must include what this pass already wrote.
			ctx.index = store.renderIndex();
			decisions.push({ kind: proposal.kind, slug: verdict.slug, decision: "accepted", reason: verdict.reason });
			result.accepted++;
		}

		const notes: string[] = [];
		let refuted = 0;
		for (const r of parsed.refuted) {
			if (refuted >= PASS_CAPS.refutations) {
				notes.push(`- skipped refutation of raw:${r.rawId}: pass cap`);
				continue;
			}
			if (!sampled.has(r.rawId)) {
				notes.push(`- skipped refutation of raw:${r.rawId}: not sampled this pass`);
				continue;
			}
			const pattern = store.getPattern(slugify(r.bySlug));
			if (!pattern) {
				notes.push(`- skipped refutation of raw:${r.rawId}: no pattern \`${r.bySlug}\``);
				continue;
			}
			if (dryRun) {
				refuted++;
				notes.push(`- would refute raw:${r.rawId} by \`${pattern.slug}\`: ${r.reason}`);
			} else if (store.supersedeRaw(r.rawId, pattern.id)) {
				refuted++;
				notes.push(`- refuted raw:${r.rawId} by \`${pattern.slug}\`: ${r.reason}`);
			} else {
				// Sampled rows are raw and unsuperseded when read; the only way the
				// update misses is a concurrent pass superseding it first.
				notes.push(`- could not refute raw:${r.rawId}: already superseded`);
			}
		}
		if (notes.length > 0) summary = `${summary}\n\nRefutations:\n${notes.join("\n")}`;
	} catch (err) {
		result.errors.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
	} finally {
		if (answered && !logged) writeLog();
	}
	return result;
}
