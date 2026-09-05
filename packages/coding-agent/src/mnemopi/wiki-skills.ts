/**
 * Skill Proposer: promotes RECURRING wiki patterns into managed skills
 * (WikiSkill §3.2.4, taste-gated — see the design note in `wiki.ts`).
 *
 * One pass makes at most ONE atomic change: create one skill, or replace one
 * existing skill's SKILL.md. The paper's reason is auditability — a single
 * diff per pass is what `skill-impact` can render and what a reviewer can
 * reject — and the audit trail is also what stops the next pass from
 * re-proposing: a pattern cited by a REJECTED entry newer than the pattern's
 * last edit is not a candidate until the maintainer changes it.
 *
 * `PURPOSE.md` is a sidecar this module owns, beside SKILL.md: the paragraph
 * the proposer wrote for why the skill exists plus the pattern slugs it was
 * minted from. It is deliberately not inside SKILL.md, whose body is what the
 * agent reads at skill-load time; provenance is for the proposer and for
 * humans reading the tree.
 *
 * `writeManagedSkill` resolves its root from `getAgentDir()` and takes no
 * override, so `agentDir` here has to name the process agent dir; a mismatch
 * is refused before anything is written rather than reading one tree and
 * writing another.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import {
	getManagedSkillsDir,
	isValidManagedSkillName,
	MAX_MANAGED_SKILL_BYTES,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import type { SkillImpactEntry, WikiPattern, WikiStore } from "./wiki";

export type Complete = (prompt: string, opts?: { maxTokens?: number; temperature?: number }) => Promise<string | null>;

export interface SkillPassResult {
	skipped?: "no-llm" | "no-candidates" | "malformed-output";
	action: "create" | "patch" | "no_action";
	skill: string | null;
	decision: "accepted" | "rejected" | null;
	reason: string;
}

export interface SkillPassOptions {
	complete?: Complete;
	agentDir?: string;
	now?: Date;
	/** Distinct raw-layer sessions a pattern needs before it can become a skill. */
	minSessions?: number;
}

export interface ManagedSkillSnapshot {
	name: string;
	description: string;
	/** Full SKILL.md file text (frontmatter included) — what the diff is computed over. */
	file: string;
	body: string;
	purpose: PurposeFile | null;
}

export interface PurposeFile {
	purpose: string;
	patterns: string[];
}

export const PURPOSE_FILENAME = "PURPOSE.md";
export const MIN_SKILL_BODY_CHARS = 300;
export const MAX_SKILL_DESCRIPTION_CHARS = 200;
/** Existing SKILL.md bodies are truncated to this in the proposer prompt. */
const PROMPT_SKILL_BODY_MAX_CHARS = 4000;
const DIFF_MAX_LINES = 60;
/** Shortest run of consecutive `## Fix` tokens that counts as "mentions the fix". */
const FIX_TOKEN_MIN_CHARS = 12;

// ---- Pure helpers (unit-tested) ---------------------------------------------

/** Strip ``` fences and take the outermost `{…}`; null when nothing parses to an object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
	const unfenced = raw.replace(/```(?:json)?/gi, "");
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function normalizeTokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9_./-]+/g, " ")
		.split(" ")
		.filter(t => t !== "");
}

/**
 * The text of a pattern's `## Fix` section; falls back to the FIX clause of
 * the index line, then to the whole body, so a pattern without headings still
 * has something for the substance check to bite on.
 */
export function fixSectionOf(patternBody: string): string {
	const heading = /^#{1,6}\s*fix\b[^\n]*\n([\s\S]*?)(?=^#{1,6}\s|\s*$(?![\s\S]))/im.exec(patternBody);
	if (heading?.[1]?.trim()) return heading[1].trim();
	const clause = /\bFIX\b:?\s*([^\n]+)/i.exec(patternBody);
	if (clause?.[1]?.trim()) return clause[1].trim();
	return patternBody;
}

/**
 * Cheap substance check: does `skillBody` contain at least one run of
 * consecutive tokens (≥ FIX_TOKEN_MIN_CHARS when joined) from the pattern's
 * fix? Token runs rather than single words so "run the tests" in a generic
 * skill does not count as citing a fix that says "run `git var GIT_AUTHOR_IDENT`".
 */
export function bodyMentionsFix(skillBody: string, patternBody: string): boolean {
	const fix = normalizeTokens(fixSectionOf(patternBody));
	if (fix.length === 0) return false;
	const haystack = ` ${normalizeTokens(skillBody).join(" ")} `;
	for (let i = 0; i < fix.length; i++) {
		let run = fix[i] as string;
		for (let j = i + 1; run.length < FIX_TOKEN_MIN_CHARS && j < fix.length; j++) run += ` ${fix[j]}`;
		if (run.length >= FIX_TOKEN_MIN_CHARS && haystack.includes(` ${run} `)) return true;
	}
	return false;
}

/**
 * Line-based unified diff (single hunk after trimming the common prefix and
 * suffix, so a patch to one paragraph of a 2000-line SKILL.md costs an LCS
 * over the changed window, not the whole file). Truncated to `maxLines`.
 */
export function unifiedDiff(oldText: string, newText: string, name = "SKILL.md", maxLines = DIFF_MAX_LINES): string {
	if (oldText === newText) return "";
	const a = oldText === "" ? [] : oldText.split("\n");
	const b = newText === "" ? [] : newText.split("\n");
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}
	const mid = { a: a.slice(prefix, a.length - suffix), b: b.slice(prefix, b.length - suffix) };
	const n = mid.a.length;
	const m = mid.b.length;
	const width = m + 1;
	const lcs = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * width + j] =
				mid.a[i] === mid.b[j]
					? (lcs[(i + 1) * width + j + 1] as number) + 1
					: Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
		}
	}
	const lines: string[] = [];
	// One line of context on each side of the changed window, when it exists.
	if (prefix > 0) lines.push(` ${a[prefix - 1]}`);
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && mid.a[i] === mid.b[j]) {
			lines.push(` ${mid.a[i]}`);
			i++;
			j++;
		} else if (j < m && (i >= n || (lcs[i * width + j + 1] as number) >= (lcs[(i + 1) * width + j] as number))) {
			lines.push(`+${mid.b[j]}`);
			j++;
		} else {
			lines.push(`-${mid.a[i]}`);
			i++;
		}
	}
	if (suffix > 0) lines.push(` ${a[a.length - suffix]}`);
	// Hunk starts on the leading context line (1-based `prefix`) when there is one; an empty side starts at 0.
	const context = (prefix > 0 ? 1 : 0) + (suffix > 0 ? 1 : 0);
	const oldStart = prefix > 0 ? prefix : Math.min(1, a.length);
	const newStart = prefix > 0 ? prefix : Math.min(1, b.length);
	const header = [`--- a/${name}`, `+++ b/${name}`, `@@ -${oldStart},${n + context} +${newStart},${m + context} @@`];
	const budget = Math.max(1, maxLines - header.length);
	const body =
		lines.length > budget ? [...lines.slice(0, budget - 1), `... (${lines.length - budget + 1} more lines)`] : lines;
	return [...header, ...body].join("\n");
}

export function renderPurposeFile(input: PurposeFile): string {
	return `# Purpose\n\n${input.purpose.trim()}\n\npatterns:\n${input.patterns.map(slug => `- ${slug}`).join("\n")}\n`;
}

export function parsePurposeFile(text: string): PurposeFile {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const marker = lines.findIndex(line => /^patterns:\s*$/i.test(line));
	const purposeLines = (marker < 0 ? lines : lines.slice(0, marker)).filter(line => !/^#\s*purpose\s*$/i.test(line));
	const patterns: string[] = [];
	if (marker >= 0) {
		for (const line of lines.slice(marker + 1)) {
			const item = /^-\s+(\S+)/.exec(line);
			if (item?.[1]) patterns.push(item[1]);
		}
	}
	return { purpose: purposeLines.join("\n").trim(), patterns };
}

/**
 * `created_at` on wiki rows is SQLite `CURRENT_TIMESTAMP` (UTC, second
 * resolution, no `T`), while `updated_at` in pattern metadata is an ISO
 * string. Comparing them as strings would rank every rejection before every
 * pattern, so both go through this to epoch SECONDS — the coarser of the two.
 */
export function toEpochSeconds(stamp: string): number {
	const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(stamp);
	const ms = Date.parse(sql ? `${sql[1]}T${sql[2]}Z` : stamp);
	return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/**
 * Patterns eligible for promotion: recur across ≥ `minSessions` sessions, are
 * not yet cited by any skill, and were not the subject of a rejection since
 * their last edit.
 */
export function selectCandidates(
	patterns: readonly WikiPattern[],
	impact: readonly SkillImpactEntry[],
	minSessions: number,
): WikiPattern[] {
	const rejectedAt = new Map<string, number>();
	for (const entry of impact) {
		if (entry.decision !== "rejected") continue;
		const at = toEpochSeconds(entry.at);
		for (const slug of entry.patterns) rejectedAt.set(slug, Math.max(rejectedAt.get(slug) ?? 0, at));
	}
	return patterns.filter(
		p =>
			p.sessions.length >= minSessions &&
			p.skills.length === 0 &&
			(rejectedAt.get(p.slug) ?? -1) < toEpochSeconds(p.updatedAt),
	);
}

// ---- Skills on disk -----------------------------------------------------------

export async function readManagedSkills(agentDir: string): Promise<ManagedSkillSnapshot[]> {
	const root = getManagedSkillsDir(agentDir);
	const entries = await fs.readdir(root, { withFileTypes: true }).catch(err => {
		if (isEnoent(err)) return [];
		throw err;
	});
	const skills: ManagedSkillSnapshot[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isValidManagedSkillName(entry.name)) continue;
		const dir = path.join(root, entry.name);
		const file = await fs.readFile(path.join(dir, "SKILL.md"), "utf8").catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		if (file === null) continue;
		const { frontmatter, body } = parseFrontmatter(file, { source: dir, level: "off" });
		const purposeText = await fs.readFile(path.join(dir, PURPOSE_FILENAME), "utf8").catch(err => {
			if (isEnoent(err)) return null;
			throw err;
		});
		skills.push({
			name: entry.name,
			description: typeof frontmatter.description === "string" ? frontmatter.description : "",
			file,
			body,
			purpose: purposeText === null ? null : parsePurposeFile(purposeText),
		});
	}
	return skills;
}

// ---- Prompts -------------------------------------------------------------------

export const ONE_CHANGE_RULE =
	"Propose AT MOST ONE atomic change per pass: create ONE new skill, or patch ONE existing skill, or no_action. Never two.";

export function buildProposerPrompt(
	candidates: readonly WikiPattern[],
	skills: readonly ManagedSkillSnapshot[],
	history: string,
): string {
	const candidateText = candidates
		.map(p => `### ${p.slug} (${p.sessions.length} sessions, ${p.evidence.length} raw rows)\n${p.body.trim()}`)
		.join("\n\n");
	const skillText =
		skills.length === 0
			? "(no managed skills yet)"
			: skills
					.map(s => {
						const body =
							s.body.length > PROMPT_SKILL_BODY_MAX_CHARS
								? `${s.body.slice(0, PROMPT_SKILL_BODY_MAX_CHARS)}\n… (truncated)`
								: s.body;
						const purpose = s.purpose
							? `PURPOSE.md: ${s.purpose.purpose}\ncites patterns: ${s.purpose.patterns.join(", ") || "(none)"}`
							: "PURPOSE.md: (none)";
						return `### ${s.name}\ndescription: ${s.description}\n${purpose}\n\nSKILL.md body:\n${body}`;
					})
					.join("\n\n");
	return [
		"You are the Skill Proposer for an agent's procedural memory. Wiki patterns below are root-caused failure modes",
		"that RECURRED across sessions. Decide whether one of them (or several closely related ones) deserves a managed",
		"skill — a concrete, step-by-step procedure a fresh agent follows to avoid the failure — or whether an existing",
		"skill should be patched to cover them.",
		"",
		ONE_CHANGE_RULE,
		"A skill body must be CONCRETE: exact commands, file paths, checks to run, and what a wrong result looks like.",
		'Generic advice ("be careful", "verify your work") is rejected. The body must restate each cited pattern\'s FIX in',
		`substance. Body length ${MIN_SKILL_BODY_CHARS}–${MAX_MANAGED_SKILL_BYTES} characters; description ≤ ${MAX_SKILL_DESCRIPTION_CHARS} characters, written as WHEN to use the skill.`,
		"Do not re-propose anything the history below rejected unless the patterns changed.",
		"",
		"## Candidate patterns",
		candidateText,
		"",
		"## Existing managed skills",
		skillText,
		"",
		"## Skill proposal history (newest first)",
		history,
		"",
		"Respond with STRICT JSON only, no prose, no fences:",
		'{ "action": "create" | "patch" | "no_action", "name": "<skill-name: lowercase, digits, hyphens>",',
		'  "description": "<when to use, ≤200 chars>", "body": "<full SKILL.md body (create) or full replacement body (patch)>",',
		'  "purpose": "<one paragraph: why this skill exists>", "patterns": ["<cited pattern slug>", ...],',
		'  "reason": "<why this change, or why no_action>" }',
		'For "no_action" leave name/body empty and patterns [].',
	].join("\n");
}

export function buildJudgePrompt(
	proposal: Proposal,
	cited: readonly WikiPattern[],
	skills: readonly ManagedSkillSnapshot[],
): string {
	const others = skills.filter(s => s.name !== proposal.name);
	return [
		"You are the taste gate for a proposed agent skill. Judge it against the failures it claims to prevent.",
		"",
		`## Proposed ${proposal.action} of skill \`${proposal.name}\``,
		`description: ${proposal.description}`,
		`purpose: ${proposal.purpose}`,
		"",
		"### SKILL.md body",
		proposal.body,
		"",
		"## Patterns it cites (the failures it must prevent)",
		cited.map(p => `### ${p.slug}\n${p.body.trim()}`).join("\n\n"),
		"",
		"## Other existing skills (it must not contradict these)",
		others.length === 0
			? "(none)"
			: others
					.map(s => `### ${s.name}\n${s.description}\n${s.body.slice(0, PROMPT_SKILL_BODY_MAX_CHARS / 2)}`)
					.join("\n\n"),
		"",
		"Answer three questions: (1) Would a fresh agent following this skill avoid the cited failures?",
		"(2) Is it concrete — commands, files, checks — rather than generic advice? (3) Does it contradict any existing skill?",
		"Accept only if 1 and 2 are yes and 3 is no.",
		'Respond with STRICT JSON only: { "accept": true | false, "reason": "<one sentence>" }',
	].join("\n");
}

// ---- Proposal shape ------------------------------------------------------------

export interface Proposal {
	action: "create" | "patch";
	name: string;
	description: string;
	body: string;
	purpose: string;
	patterns: string[];
	reason: string;
}

type Parsed = { kind: "no_action"; reason: string } | { kind: "proposal"; proposal: Proposal } | { kind: "malformed" };

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function parseProposal(raw: string): Parsed {
	const obj = parseJsonObject(raw);
	if (!obj) return { kind: "malformed" };
	const action = obj.action;
	if (action === "no_action") return { kind: "no_action", reason: asString(obj.reason) || "model chose no_action" };
	if (action !== "create" && action !== "patch") return { kind: "malformed" };
	const patterns = Array.isArray(obj.patterns) ? obj.patterns.filter((p): p is string => typeof p === "string") : [];
	return {
		kind: "proposal",
		proposal: {
			action,
			name: asString(obj.name),
			description: asString(obj.description),
			body: asString(obj.body),
			purpose: asString(obj.purpose),
			patterns,
			reason: asString(obj.reason),
		},
	};
}

/**
 * Hard invariants, enforced in code before any model judges taste. Returns
 * the normalized name and resolved patterns, or the first violated rule.
 */
export function gateProposal(
	proposal: Proposal,
	store: WikiStore,
	skills: readonly ManagedSkillSnapshot[],
): { ok: true; name: string; cited: WikiPattern[] } | { ok: false; reason: string } {
	const name = proposal.name.trim().toLowerCase();
	if (!isValidManagedSkillName(name)) return { ok: false, reason: `invalid skill name "${proposal.name}"` };
	if (proposal.patterns.length === 0) return { ok: false, reason: "proposal cites no patterns" };
	const cited: WikiPattern[] = [];
	for (const slug of new Set(proposal.patterns)) {
		const pattern = store.getPattern(slug);
		if (!pattern) return { ok: false, reason: `cited pattern "${slug}" does not exist` };
		cited.push(pattern);
	}
	const exists = skills.some(s => s.name === name);
	if (proposal.action === "create" && exists)
		return { ok: false, reason: `skill "${name}" already exists; use patch` };
	if (proposal.action === "patch" && !exists)
		return { ok: false, reason: `skill "${name}" does not exist; use create` };
	const body = proposal.body.trim();
	if (body.length < MIN_SKILL_BODY_CHARS) {
		return { ok: false, reason: `body is ${body.length} chars; minimum is ${MIN_SKILL_BODY_CHARS}` };
	}
	if (Buffer.byteLength(body, "utf8") > MAX_MANAGED_SKILL_BYTES) {
		return { ok: false, reason: `body exceeds ${MAX_MANAGED_SKILL_BYTES} bytes` };
	}
	const description = proposal.description.trim();
	if (description === "" || description.length > MAX_SKILL_DESCRIPTION_CHARS) {
		return { ok: false, reason: `description must be 1–${MAX_SKILL_DESCRIPTION_CHARS} chars` };
	}
	for (const pattern of cited) {
		if (!bodyMentionsFix(body, pattern.body)) {
			return { ok: false, reason: `body does not restate the fix of cited pattern "${pattern.slug}"` };
		}
	}
	return { ok: true, name, cited };
}

// ---- The pass ------------------------------------------------------------------

export async function runSkillProposerPass(store: WikiStore, options: SkillPassOptions = {}): Promise<SkillPassResult> {
	const noAction: SkillPassResult = { action: "no_action", skill: null, decision: null, reason: "" };
	try {
		if (!options.complete && !store.memory.llmEnabled)
			return { ...noAction, skipped: "no-llm", reason: "no LLM configured" };
		const complete = options.complete ?? store.memory.complete.bind(store.memory);
		const agentDir = options.agentDir ?? getAgentDir();
		if (path.resolve(agentDir) !== path.resolve(getAgentDir())) {
			return {
				...noAction,
				reason: `agentDir ${agentDir} is not the process agent dir ${getAgentDir()}; writeManagedSkill is pinned to the latter`,
			};
		}
		const at = (options.now ?? new Date()).toISOString();
		const minSessions = options.minSessions ?? 2;

		const candidates = selectCandidates(store.listPatterns(), store.listSkillImpact(), minSessions);
		if (candidates.length === 0) {
			return {
				...noAction,
				skipped: "no-candidates",
				reason: `no pattern recurs across ${minSessions}+ sessions uncited`,
			};
		}
		const skills = await readManagedSkills(agentDir);

		const raw = await complete(buildProposerPrompt(candidates, skills, store.renderSkillImpact()), {
			maxTokens: 2000,
			temperature: 0.2,
		});
		const parsed = parseProposal(raw ?? "");
		if (parsed.kind === "malformed") {
			return { ...noAction, skipped: "malformed-output", reason: "proposer output was not the expected JSON" };
		}
		if (parsed.kind === "no_action") {
			store.appendSkillImpact({
				at,
				action: "no_action",
				skill: null,
				patterns: [],
				diff: "",
				decision: "accepted",
				reason: parsed.reason,
			});
			return { action: "no_action", skill: null, decision: "accepted", reason: parsed.reason };
		}

		const { proposal } = parsed;
		const action = proposal.action;
		// A rejected entry still names the skill when the name is at least well-formed,
		// so `renderSkillImpact` history reads "REJECTED create <name>" for the next pass.
		const proposedName = proposal.name.trim().toLowerCase();
		const reject = (skill: string | null, reason: string): SkillPassResult => {
			store.appendSkillImpact({
				at,
				action,
				skill,
				patterns: proposal.patterns,
				diff: "",
				decision: "rejected",
				reason,
			});
			return { action, skill, decision: "rejected", reason };
		};

		const gate = gateProposal(proposal, store, skills);
		if (!gate.ok) return reject(isValidManagedSkillName(proposedName) ? proposedName : null, gate.reason);
		const { name, cited } = gate;

		const verdictRaw = await complete(buildJudgePrompt({ ...proposal, name }, cited, skills), {
			maxTokens: 400,
			temperature: 0.2,
		});
		const verdict = parseJsonObject(verdictRaw ?? "");
		if (!verdict || typeof verdict.accept !== "boolean")
			return reject(name, "judge output was not the expected JSON");
		const judgeReason = asString(verdict.reason) || (verdict.accept ? "judge accepted" : "judge rejected");
		if (!verdict.accept) return reject(name, judgeReason);

		const before = skills.find(s => s.name === name)?.file ?? "";
		const written = await writeManagedSkill({
			action: action === "create" ? "create" : "update",
			name,
			description: proposal.description.trim(),
			body: proposal.body.trim(),
		});
		const after = await fs.readFile(written.path, "utf8");
		await fs.writeFile(
			path.join(path.dirname(written.path), PURPOSE_FILENAME),
			renderPurposeFile({ purpose: proposal.purpose || proposal.reason, patterns: cited.map(p => p.slug) }),
			"utf8",
		);
		for (const pattern of cited) {
			// Body and evidence are left exactly as they are; only the citation is added.
			store.updatePattern(pattern.slug, {
				body: pattern.body,
				evidence: [],
				skills: [...new Set([...pattern.skills, name])],
			});
		}
		const reason = `${judgeReason} (proposer: ${proposal.reason || "n/a"})`;
		store.appendSkillImpact({
			at,
			action,
			skill: name,
			patterns: cited.map(p => p.slug),
			diff: unifiedDiff(before, after),
			decision: "accepted",
			reason,
		});
		return { action, skill: name, decision: "accepted", reason };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		try {
			store.appendSkillImpact({
				at: (options.now ?? new Date()).toISOString(),
				action: "no_action",
				skill: null,
				patterns: [],
				diff: "",
				decision: "rejected",
				reason: `pass failed: ${reason}`,
			});
		} catch {
			// The store itself is unavailable; the result object is the only report left.
		}
		return { ...noAction, decision: "rejected", reason: `pass failed: ${reason}` };
	}
}
