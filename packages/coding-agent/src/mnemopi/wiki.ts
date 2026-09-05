/**
 * Wiki layer: compiled knowledge over raw memory (WikiSkill, arXiv:2608.27454).
 *
 * mnemopi's banks hold the RAW layer — whole transcript chunks retained as
 * `memory_type=episode` rows — and until this module that was also what got
 * recalled and injected: measured on 2026-09-04, the largest bank on the box
 * held 9 rows averaging 295K chars each, zero extracted facts, and a
 * `consolidation_log` that had never been written. `sleep()` joins old rows
 * with `" | "` (`llm_used: 0`) and later truncates them; nothing ever judged
 * whether a memory was duplicated, contradicted, stale, or wrong, and
 * `superseded_by` was NULL in every bank.
 *
 * WikiSkill's fix is a layer BETWEEN raw experience and what the agent reads:
 *
 *   raw/   immutable transcripts           → existing episode rows, never edited
 *   wiki/  compiled patterns + audit trail  → rows written by the background
 *          Wiki Maintainer (memory_type `pattern`), one per root-caused
 *          failure mode or proven strategy, each citing the raw rows that
 *          evidence it; plus `wiki-log` (one row per maintainer pass, incl.
 *          every REJECTED proposal and why) and `skill-impact` (every skill
 *          proposal, its diff, and its outcome). The audit rows are what stops
 *          the next pass re-proposing what the last one rejected.
 *   skills/ procedural knowledge            → existing managed-skills dir,
 *          minted by the Skill Proposer from patterns that RECUR.
 *
 * The paper gates skill updates on a validation-set score. This box has no
 * task set with ground truth, so gating is by taste instead (see
 * `wiki-gate.ts`): hard invariants enforced in code, a small-model judge with
 * a rubric, and recurrence across sessions as the bar for promoting a pattern
 * into a skill. Every rejection is logged, which is the property the paper's
 * ablation attributes the gains to — persistent knowledge that compounds.
 *
 * Rows, not files. The memory tree is a pure projection of the bank
 * (`tree.ts`), so the wiki lives as bank rows with `metadata.subtree` set and
 * renders as `<bank>/wiki/patterns/<slug>.md` etc. with the existing renderer
 * untouched. A pattern row's FIRST LINE is its index entry — the renderer's
 * subtree `MEMORY.md` shows the first 140 chars of content per leaf, and the
 * paper is explicit that index quality is what decides whether an agent ever
 * opens the page, so the maintainer is made to write PROBLEM + ROOT CAUSE +
 * FIX into that one line.
 *
 * All wiki rows carry `session_id = WIKI_SESSION_ID`. `updateWorking` scopes
 * writes to the beam's own session, so the store operates on a beam clone
 * bound to that id (the same trick `sleepAllSessions` uses) — a pattern
 * created by one lane's pass is then updatable by every later pass.
 */
import type { BeamMemory, Mnemopi } from "@oh-my-pi/pi-mnemopi";

export const WIKI_SESSION_ID = "wiki-maintainer";
export const WIKI_SOURCE = "wiki-maintainer";
export const PATTERN_MEMORY_TYPE = "pattern";
export const WIKI_LOG_MEMORY_TYPE = "wiki-log";
export const SKILL_IMPACT_MEMORY_TYPE = "skill-impact";
export const PATTERNS_SUBTREE = "wiki/patterns";
export const WIKI_LOG_SUBTREE = "wiki/log";
export const SKILL_IMPACT_SUBTREE = "wiki/skill-impact";
/** Raw-layer rows the maintainer reads. Matches what `retainMessages` writes. */
export const RAW_SOURCE = "coding-agent-transcript";
export const RAW_MEMORY_TYPE = "episode";
/**
 * Paper §C: index entries must be judgeable without opening the page. The
 * tree index shows the first {@link INDEX_LINE_TARGET_CHARS} of the line, so
 * that is what the maintainer is told to aim for. The hard cap only catches
 * a runaway paragraph: a smol model cannot count characters, and measured on
 * SkyRail passes it wrote 170–200 when told "at most 140" and 205–262 when
 * told "about 140, max 200" — gating on length threw away every otherwise
 * grounded proposal while changing nothing about how long they were.
 */
export const INDEX_LINE_TARGET_CHARS = 140;
export const INDEX_LINE_MAX_CHARS = 400;
export const PATTERN_SLUG_MAX_CHARS = 64;

// ---- Patch operations (paper §E.2 / §E.3, verbatim semantics) --------------

export type PatchOp =
	| { op: "append"; content: string }
	| { op: "replace"; target: string; content: string }
	| { op: "insert_after"; target: string; content: string };

export type PatchResult = { ok: true; body: string } | { ok: false; error: string };

/**
 * Apply patch ops in order. `target` must be an EXACT substring (paper rule 1)
 * and — stricter than the paper, because an LLM-chosen target that matches
 * twice would silently edit the wrong occurrence — must match exactly once.
 * A failed op aborts the whole patch: a half-applied pattern page is worse
 * than an unchanged one, since the next pass reads it as ground truth.
 */
export function applyPatchOps(body: string, ops: readonly PatchOp[]): PatchResult {
	let next = body;
	for (const [i, op] of ops.entries()) {
		if (op.op === "append") {
			if (op.content.trim() === "") return { ok: false, error: `op ${i}: append with empty content` };
			next = next.replace(/\s*$/, "") + "\n" + op.content.replace(/^\n+/, "");
			continue;
		}
		if (typeof op.target !== "string" || op.target === "") {
			return { ok: false, error: `op ${i}: ${op.op} requires a non-empty target` };
		}
		const first = next.indexOf(op.target);
		if (first < 0)
			return { ok: false, error: `op ${i}: target not found: ${JSON.stringify(op.target.slice(0, 60))}` };
		if (next.indexOf(op.target, first + 1) >= 0) {
			return { ok: false, error: `op ${i}: target is ambiguous (matches more than once)` };
		}
		if (op.op === "replace") {
			next = next.slice(0, first) + op.content + next.slice(first + op.target.length);
		} else {
			const end = first + op.target.length;
			next = `${next.slice(0, end)}\n${op.content.replace(/^\n+/, "")}${next.slice(end)}`;
		}
	}
	return { ok: true, body: next };
}

/** Parse a loosely-typed `edits` array from model JSON into PatchOps, or null. */
export function parsePatchOps(raw: unknown): PatchOp[] | null {
	if (!Array.isArray(raw)) return null;
	const ops: PatchOp[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") return null;
		const e = entry as Record<string, unknown>;
		const content = typeof e.content === "string" ? e.content : null;
		if (content === null) return null;
		if (e.op === "append") ops.push({ op: "append", content });
		else if ((e.op === "replace" || e.op === "insert_after") && typeof e.target === "string") {
			ops.push({ op: e.op, target: e.target, content });
		} else return null;
	}
	return ops;
}

// ---- Row shapes --------------------------------------------------------------

export interface WikiPattern {
	id: string;
	slug: string;
	/** First line of the body: PROBLEM + ROOT CAUSE + FIX. */
	indexLine: string;
	body: string;
	/** Raw-layer row ids this pattern is grounded in. Never empty once stored. */
	evidence: string[];
	/** Distinct raw-layer `session_id`s behind `evidence` — recurrence is judged on this. */
	sessions: string[];
	/** Managed skill names that cite this pattern in PURPOSE.md, if any. */
	skills: string[];
	version: number;
	createdAt: string;
	updatedAt: string;
}

export interface RawRow {
	id: string;
	content: string;
	sessionId: string;
	createdAt: string;
	metadata: Record<string, unknown>;
}

export type MaintainerDecision = "accepted" | "rejected";

export interface WikiLogEntry {
	/** ISO timestamp of the pass. */
	at: string;
	/** Raw row ids sampled for this pass. */
	sampled: string[];
	/** Free-text summary the maintainer wrote (paper: `append_log`). */
	summary: string;
	/** Every proposal considered, with the gate's verdict — rejections included, by design. */
	decisions: Array<{ kind: "create" | "update"; slug: string; decision: MaintainerDecision; reason: string }>;
}

export interface SkillImpactEntry {
	at: string;
	action: "create" | "patch" | "no_action";
	skill: string | null;
	/** Pattern slugs cited in PURPOSE.md. */
	patterns: string[];
	/** Unified diff of the SKILL.md change (paper §3.2.4), empty for no_action. */
	diff: string;
	decision: MaintainerDecision;
	reason: string;
}

// ---- Store -------------------------------------------------------------------

type Row = Record<string, unknown>;

function str(row: Row, key: string): string | null {
	const v = row[key];
	return typeof v === "string" ? v : null;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
}

export function slugify(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/\.md$/, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, PATTERN_SLUG_MAX_CHARS)
		.replace(/-+$/, "");
}

/** Split a stored pattern body into its index line and the rest. */
export function splitIndexLine(body: string): { indexLine: string; rest: string } {
	const trimmed = body.replace(/^\s+/, "");
	const nl = trimmed.indexOf("\n");
	const first = (nl < 0 ? trimmed : trimmed.slice(0, nl)).replace(/^#+\s*/, "").trim();
	return { indexLine: first, rest: nl < 0 ? "" : trimmed.slice(nl + 1) };
}

/**
 * The wiki's view of one bank. Wraps the bank's `Mnemopi` with a beam clone
 * bound to `WIKI_SESSION_ID` so reads and writes all land on wiki-owned rows.
 */
export class WikiStore {
	readonly bank: string;
	readonly memory: Mnemopi;
	readonly #beam: BeamMemory;

	constructor(bank: string, memory: Mnemopi) {
		this.bank = bank;
		this.memory = memory;
		// Same construction `sleepAllSessions` uses to run a session-scoped
		// operation on another session's rows: prototype-preserving clone with
		// the id swapped. `sessionId`/`channelId` are plain fields on the beam.
		const scoped = Object.create(Object.getPrototypeOf(memory.beam)) as BeamMemory;
		Object.assign(scoped, memory.beam, { sessionId: WIKI_SESSION_ID, channelId: WIKI_SESSION_ID });
		this.#beam = scoped;
	}

	// -- raw layer (read-only) --

	/** Raw episode rows newer than `sinceIso` (or all), oldest first. */
	rawRowsSince(sinceIso: string | null, limit = 200): RawRow[] {
		const rows = this.memory.db
			.query(
				`SELECT id, content, session_id, created_at, metadata_json FROM working_memory
				 WHERE source = ? AND memory_type = ? AND superseded_by IS NULL AND created_at > ?
				 ORDER BY created_at ASC LIMIT ?`,
			)
			.all(RAW_SOURCE, RAW_MEMORY_TYPE, sinceIso ?? "", limit) as Row[];
		return rows.map(row => ({
			id: str(row, "id") ?? "",
			content: str(row, "content") ?? "",
			sessionId: str(row, "session_id") ?? "default",
			createdAt: str(row, "created_at") ?? "",
			metadata: parseMetadata(str(row, "metadata_json")),
		}));
	}

	rawRowExists(id: string): boolean {
		const row = this.memory.db
			.query(`SELECT 1 AS one FROM working_memory WHERE id = ? AND source = ? AND memory_type = ?`)
			.get(id, RAW_SOURCE, RAW_MEMORY_TYPE);
		return row !== null;
	}

	rawSessionsOf(ids: readonly string[]): string[] {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(",");
		const rows = this.memory.db
			.query(`SELECT DISTINCT session_id FROM working_memory WHERE id IN (${placeholders})`)
			.all(...ids) as Row[];
		return rows.map(row => str(row, "session_id") ?? "default").sort();
	}

	/**
	 * Mark a raw row as refuted by a pattern. The row is not deleted — the
	 * raw layer is immutable — but `superseded_by` takes it out of recall and
	 * out of the next maintainer pass. This is the ONLY write the wiki makes
	 * to the raw layer. Direct SQL rather than `beam.invalidate`, which scopes
	 * the update to the beam's own session: raw rows are retained by whichever
	 * lane produced them, and the wiki must be able to refute any of them.
	 * Restricted to raw rows so a bad id from the model can never touch a
	 * pattern or audit row.
	 */
	supersedeRaw(rawId: string, byPatternId: string): boolean {
		const result = this.memory.db.run(
			`UPDATE working_memory SET valid_until = ?, superseded_by = ?
			 WHERE id = ? AND source = ? AND memory_type = ? AND superseded_by IS NULL`,
			[new Date().toISOString(), byPatternId, rawId, RAW_SOURCE, RAW_MEMORY_TYPE],
		);
		return result.changes > 0;
	}

	// -- patterns --

	listPatterns(): WikiPattern[] {
		const rows = this.memory.db
			.query(
				`SELECT id, content, metadata_json, created_at, timestamp FROM working_memory
				 WHERE session_id = ? AND memory_type = ? AND superseded_by IS NULL ORDER BY created_at ASC`,
			)
			.all(WIKI_SESSION_ID, PATTERN_MEMORY_TYPE) as Row[];
		return rows.map(row => this.#toPattern(row));
	}

	getPattern(slug: string): WikiPattern | undefined {
		return this.listPatterns().find(pattern => pattern.slug === slug);
	}

	/** The paper's `index.md`: one line per pattern, judgeable without opening the page. */
	renderIndex(): string {
		const patterns = this.listPatterns();
		if (patterns.length === 0) return "(no patterns yet)";
		return patterns
			.map(
				p =>
					`- [${p.slug}](wiki/patterns/${p.slug}.md): ${p.indexLine} (evidence: ${p.evidence.length} rows, ${p.sessions.length} sessions)`,
			)
			.join("\n");
	}

	createPattern(input: { slug: string; body: string; evidence: string[] }): WikiPattern {
		const slug = slugify(input.slug);
		const sessions = this.rawSessionsOf(input.evidence);
		const now = new Date().toISOString();
		const id = this.#beam.remember(input.body, {
			source: WIKI_SOURCE,
			importance: 0.85,
			// Inferred, not stated: a pattern is the maintainer's reading of the
			// evidence, and the veracity tag is what recall weights it by.
			veracity: "inferred",
			memoryType: PATTERN_MEMORY_TYPE,
			scope: "bank",
			extract: false,
			extractEntities: false,
			metadata: {
				subtree: PATTERNS_SUBTREE,
				slug,
				evidence: input.evidence,
				sessions,
				skills: [],
				version: 1,
				updated_at: now,
				// `connections` is what the tree renderer prints on the leaf
				// header, so the raw rows become one hop away for a reader.
				connections: input.evidence,
			},
		});
		const created = this.listPatterns().find(p => p.id === id);
		if (!created) throw new Error(`wiki: pattern ${slug} was not stored`);
		return created;
	}

	/** Replace a pattern's body/metadata in place (already-gated content). */
	updatePattern(slug: string, next: { body: string; evidence: string[]; skills?: string[] }): WikiPattern | undefined {
		const existing = this.getPattern(slug);
		if (!existing) return undefined;
		const evidence = [...new Set([...existing.evidence, ...next.evidence])];
		const sessions = this.rawSessionsOf(evidence);
		const now = new Date().toISOString();
		const metadata = {
			subtree: PATTERNS_SUBTREE,
			slug,
			evidence,
			sessions,
			skills: next.skills ?? existing.skills,
			version: existing.version + 1,
			updated_at: now,
			connections: evidence,
		};
		// `updateWorking` re-schedules the embedding for the new body; the
		// metadata column has no facade setter, so it is written directly.
		if (!this.#beam.updateWorking(existing.id, next.body, null)) return undefined;
		this.memory.db.run(`UPDATE working_memory SET metadata_json = ?, timestamp = ? WHERE id = ?`, [
			JSON.stringify(metadata),
			now,
			existing.id,
		]);
		return this.getPattern(slug);
	}

	// -- audit trail --

	lastPassAt(): string | null {
		const row = this.memory.db
			.query(`SELECT max(created_at) AS at FROM working_memory WHERE session_id = ? AND memory_type = ?`)
			.get(WIKI_SESSION_ID, WIKI_LOG_MEMORY_TYPE) as { at: string | null } | null;
		return row?.at ?? null;
	}

	appendLog(entry: WikiLogEntry): string {
		const accepted = entry.decisions.filter(d => d.decision === "accepted");
		const rejected = entry.decisions.filter(d => d.decision === "rejected");
		const lines = [
			`Pass ${entry.at.slice(0, 16)}: ${accepted.length} accepted, ${rejected.length} rejected, ${entry.sampled.length} raw rows sampled`,
			"",
			entry.summary.trim(),
			"",
			...entry.decisions.map(d => `- ${d.decision.toUpperCase()} ${d.kind} \`${d.slug}\`: ${d.reason}`),
		];
		return this.#beam.remember(lines.join("\n"), {
			source: WIKI_SOURCE,
			importance: 0.3,
			veracity: "tool",
			memoryType: WIKI_LOG_MEMORY_TYPE,
			scope: "bank",
			extract: false,
			extractEntities: false,
			metadata: { subtree: WIKI_LOG_SUBTREE, sampled: entry.sampled, decisions: entry.decisions },
		});
	}

	listLog(limit = 20): WikiLogEntry[] {
		const rows = this.memory.db
			.query(
				`SELECT content, metadata_json, created_at FROM working_memory
				 WHERE session_id = ? AND memory_type = ? ORDER BY created_at DESC LIMIT ?`,
			)
			.all(WIKI_SESSION_ID, WIKI_LOG_MEMORY_TYPE, limit) as Row[];
		return rows.map(row => {
			const meta = parseMetadata(str(row, "metadata_json"));
			const decisions = Array.isArray(meta.decisions) ? (meta.decisions as WikiLogEntry["decisions"]) : [];
			return {
				at: str(row, "created_at") ?? "",
				sampled: stringList(meta.sampled),
				summary: str(row, "content") ?? "",
				decisions,
			};
		});
	}

	/** Slugs the gate has already rejected, with reasons — what the maintainer must not re-propose. */
	rejectedProposals(limit = 50): Array<{ slug: string; reason: string; at: string }> {
		const out: Array<{ slug: string; reason: string; at: string }> = [];
		for (const entry of this.listLog(limit)) {
			for (const d of entry.decisions) {
				if (d.decision === "rejected") out.push({ slug: d.slug, reason: d.reason, at: entry.at });
			}
		}
		return out;
	}

	appendSkillImpact(entry: SkillImpactEntry): string {
		const lines = [
			`${entry.at.slice(0, 16)} ${entry.decision.toUpperCase()} ${entry.action}${entry.skill ? ` \`${entry.skill}\`` : ""}: ${entry.reason}`,
			entry.patterns.length > 0 ? `patterns: ${entry.patterns.join(", ")}` : "",
			entry.diff ? "\n```diff\n" + entry.diff.trim() + "\n```" : "",
		].filter(l => l !== "");
		return this.#beam.remember(lines.join("\n"), {
			source: WIKI_SOURCE,
			importance: 0.3,
			veracity: "tool",
			memoryType: SKILL_IMPACT_MEMORY_TYPE,
			scope: "bank",
			extract: false,
			extractEntities: false,
			metadata: {
				subtree: SKILL_IMPACT_SUBTREE,
				action: entry.action,
				skill: entry.skill,
				patterns: entry.patterns,
				decision: entry.decision,
			},
		});
	}

	listSkillImpact(limit = 30): SkillImpactEntry[] {
		const rows = this.memory.db
			.query(
				`SELECT content, metadata_json, created_at FROM working_memory
				 WHERE session_id = ? AND memory_type = ? ORDER BY created_at DESC LIMIT ?`,
			)
			.all(WIKI_SESSION_ID, SKILL_IMPACT_MEMORY_TYPE, limit) as Row[];
		return rows.map(row => {
			const meta = parseMetadata(str(row, "metadata_json"));
			const content = str(row, "content") ?? "";
			const fence = content.indexOf("```diff\n");
			return {
				at: str(row, "created_at") ?? "",
				action: (meta.action as SkillImpactEntry["action"]) ?? "no_action",
				skill: typeof meta.skill === "string" ? meta.skill : null,
				patterns: stringList(meta.patterns),
				diff: fence >= 0 ? content.slice(fence + 8).replace(/\n```\s*$/, "") : "",
				decision: meta.decision === "accepted" ? "accepted" : "rejected",
				reason: content.split("\n")[0]?.replace(/^\S+ (ACCEPTED|REJECTED) \S+( `[^`]+`)?: /, "") ?? "",
			};
		});
	}

	/** The paper's `skill-impact.md`, rendered for a proposer prompt. */
	renderSkillImpact(limit = 30): string {
		const entries = this.listSkillImpact(limit);
		if (entries.length === 0) return "(no skill proposals yet)";
		return entries
			.map(
				e =>
					`- ${e.at.slice(0, 10)} ${e.decision.toUpperCase()} ${e.action}${e.skill ? ` ${e.skill}` : ""}: ${e.reason}${e.patterns.length ? ` [${e.patterns.join(", ")}]` : ""}`,
			)
			.join("\n");
	}

	#toPattern(row: Row): WikiPattern {
		const meta = parseMetadata(str(row, "metadata_json"));
		const body = str(row, "content") ?? "";
		const created = str(row, "created_at") ?? "";
		return {
			id: str(row, "id") ?? "",
			slug: typeof meta.slug === "string" ? meta.slug : slugify(str(row, "id") ?? "pattern"),
			indexLine: splitIndexLine(body).indexLine,
			body,
			evidence: stringList(meta.evidence),
			sessions: stringList(meta.sessions),
			skills: stringList(meta.skills),
			version: typeof meta.version === "number" ? meta.version : 1,
			createdAt: created,
			updatedAt: typeof meta.updated_at === "string" ? meta.updated_at : created,
		};
	}
}
