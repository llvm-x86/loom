/**
 * Session context sync — keeps per-repo status ledgers (`<dir>/<slug>.md`)
 * up to date from the session transcript. Triggered on compaction, session
 * close, and prolonged idle (see `agent-session.ts` call sites). A total
 * no-op unless `sessionContextSync.enabled` and `sessionContextSync.dir`
 * are both configured. Never throws.
 *
 * Repo resolution has two modes, chosen automatically:
 *  - Single-repo: the session cwd is itself a git checkout → one ledger for
 *    that repo (the common one-session-one-repo case).
 *  - Multi-repo: the session cwd is a *container* (e.g. `~/workspace` holding
 *    many clones) → the transcript's tool calls are scanned for the repos the
 *    session actually worked in (edit/write/bash signals), and each touched
 *    repo's ledger is updated from its slice of the session. Falls back to a
 *    single cwd-basename ledger only when nothing is detectable.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { sanitizeBankName } from "../mnemopi/config";
import { resolveDefaultRepoMemoized } from "../tools/gh";
import { expandTilde } from "../tools/path-utils";
import {
	type ContextActivityEvent,
	type ContextActivityPhase,
	reportContextActivity,
} from "./context-activity-reporter";

export type SessionContextSyncReason = "compaction" | "shutdown" | "idle";

export interface SessionContextSyncSettings {
	enabled: boolean;
	dir: string;
	idleMinutes: number;
	minIntervalSeconds: number;
	/** Container dir under which repos live (multi-repo mode). Empty → use cwd. */
	workspaceRoot: string;
	/** Shutdown handoff spool dir (loom writes / agent-chat worker consumes). Empty disables handoff. */
	spoolDir: string;
	/** Pause/throttle control JSON file; read before spending tokens. Empty disables the gate. */
	controlFile: string;
	/** Context Activity event-ingest base URL. Empty disables reporting. */
	reportUrl: string;
}

/** Narrow slice of `AssistantMessage` this module needs — kept local so tests don't need to build a full message. */
interface EphemeralTurnAssistantMessage {
	usage?: { input?: number; output?: number; cacheRead?: number };
	model?: string;
	provider?: string;
	duration?: number;
}

/** Minimal duck-typed surface `AgentSession` satisfies; kept narrow for testability. */
export interface SessionContextSyncSession {
	readonly cwd: string;
	readonly sessionId?: string;
	/** AI-generated session title (`AgentSession.sessionName`), for Context Activity event display. */
	readonly sessionLabel?: string;
	/** `sessionManager.getSessionFile()` — required for a `loom sync-context --resume` handoff. */
	readonly transcriptPath?: string;
	readonly settings?: { getGroup(prefix: "sessionContextSync"): SessionContextSyncSettings };
	readonly messages?: readonly unknown[];
	runEphemeralTurn(args: {
		promptText: string;
		signal?: AbortSignal;
		/**
		 * Opt out of {@link dedupeEphemeralReply}'s 4096-byte display cap. REQUIRED here:
		 * this reply is written to a file, and the cap silently truncates the ledger and
		 * appends a `[…truncated]` marker, yielding a 4097-byte file cut mid-word.
		 */
		dedupeReply?: boolean;
	}): Promise<{ replyText: string; assistantMessage?: EphemeralTurnAssistantMessage }>;
}

export interface SessionContextSyncDeps {
	/** Overridable for tests; defaults to the real `gh`-backed resolver. */
	resolveRepo?: (cwd: string) => Promise<string>;
	now?: () => number;
	/** Overridable for tests; defaults to POSTing via `reportContextActivity` at `settings.reportUrl`. */
	reportEvent?: (event: ContextActivityEvent) => void;
	/** Activity id to use instead of generating one — lets `loom sync-context --activity-id` correlate. */
	activityId?: string;
}

/** Shutdown handoff spool record — written atomically by `agent-session.ts` dispose, consumed by agent-chat's worker. */
export interface ContextSyncSpoolRequest {
	sessionId: string;
	transcriptPath: string;
	reason: "shutdown";
	ledgerDir: string;
	controlFile: string;
	repos: string[];
	cwd: string;
	createdAt: string;
}

const LEDGER_MAX_LINES = 60;
/** Cap concurrent per-repo ledger writes per sync to bound prompt size / write storms. */
const MAX_REPOS_PER_SYNC = 8;
/** Tool names that count as "worked in this repo" (vs. mere reads/searches). */
const STRONG_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
	create: true,
	str_replace: true,
	apply_patch: true,
	bash: true,
};

const LEDGER_FORMAT_CONTRACT = `Ledger format contract (rewrite the WHOLE file in place, do not append blindly):
- Top heading: "# <owner/repo> — status ledger"
- "## Landmines" — known gotchas, footguns, or things a future session must not repeat.
  REQUIRED as the FIRST "##" section, immediately after the top heading. Hazards survive a
  truncation by POSITION alone — never place any other "##" section above Landmines.
- "## Current state" — a short prose/bullet summary of where the repo/work stands.
- "## Recent changes (newest first, keep ~10)" — bullet list, each line
  "- YYYY-MM-DD <session>: what happened + a ref (file, PR, issue, commit)".
  Keep roughly the 10 most recent entries; drop the oldest when adding a new one.
- "## In flight" — work that is currently in progress, not yet landed.
Keep the whole file to at most ${LEDGER_MAX_LINES} lines. Prune stale/resolved entries instead of
letting the file grow. Merge new information into the existing sections — do not just append a
new block at the end — and keep entries that clearly came from other sessions.`;

interface SyncState {
	lastSyncAt: number;
	inFlight: boolean;
}

const syncStates = new WeakMap<object, SyncState>();

function stripCodeFence(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
	return match ? match[1].trim() : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Parse a toolCall block's `arguments` (object in-memory, JSON string on disk). */
function toolArgs(block: Record<string, unknown>): Record<string, unknown> {
	const raw = block.arguments;
	if (isRecord(raw)) return raw;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	return {};
}

/** Path-like tokens a tool call references, plus whether it's a "work" signal. */
function pathsFromToolCall(name: string, args: Record<string, unknown>): { paths: string[]; strong: boolean } {
	const paths: string[] = [];
	const push = (v: unknown) => {
		if (typeof v === "string" && v.trim()) paths.push(v.trim());
	};
	push(args.path);
	push(args.file);
	push(args.filePath);
	if (Array.isArray(args.paths)) for (const p of args.paths) push(p);
	if (name === "bash") {
		push(args.cwd);
		const command = typeof args.command === "string" ? args.command : "";
		// `cd <dir>` targets
		for (const m of command.matchAll(/\bcd\s+([^\s;&|]+)/g)) push(m[1]);
		// Whitespace tokens that look like a real path: contains a slash, not a
		// flag, and NOT a URL (`https://…`) or a git ref/range
		// (`origin/main`, `origin/main...feat/x`, `HEAD~2/…`) — those are
		// extremely common in real transcripts and are not filesystem paths.
		// Bogus candidates are cheap to over-collect here since
		// `resolveTouchedSlugs` re-checks each against the filesystem before
		// ever spawning `gh`, but trimming them here keeps the candidate set
		// (and the `MAX_REPOS_PER_SYNC` slice) meaningful.
		for (const tok of command.split(/\s+/)) {
			if (!tok.includes("/") || tok.startsWith("-")) continue;
			if (tok.includes("://")) continue; // URLs
			if (tok.includes("...")) continue; // git ref ranges, e.g. origin/main...feat/x
			if (/^[\w.-]+@[\w.-]+:/.test(tok)) continue; // scp-like git remotes, e.g. git@host:owner/repo
			push(tok.replace(/^["']|["']$/g, ""));
		}
	}
	return { paths, strong: STRONG_TOOLS[name] === true };
}

/**
 * Scan the transcript for repo directories under `workspaceRoot` the session
 * touched. Returns a map of absolute repo-dir → whether it saw a strong (work)
 * signal. A "repo dir" is the first path segment directly under the root.
 */
function touchedRepoDirs(messages: readonly unknown[], workspaceRoot: string): Map<string, { strong: boolean }> {
	const root = path.resolve(workspaceRoot);
	const dirs = new Map<string, { strong: boolean }>();
	const consider = (rawPath: string, strong: boolean) => {
		const expanded = expandTilde(rawPath);
		const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
		const rel = path.relative(root, abs);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return; // not under root
		const firstSeg = rel.split(path.sep)[0];
		if (!firstSeg || firstSeg === "..") return;
		const dir = path.join(root, firstSeg);
		const prev = dirs.get(dir);
		dirs.set(dir, { strong: (prev?.strong ?? false) || strong });
	};
	for (const m of messages) {
		const content = isRecord(m) ? m.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
			const { paths, strong } = pathsFromToolCall(block.name, toolArgs(block));
			for (const p of paths) consider(p, strong);
		}
	}
	return dirs;
}

/** Resolve touched dirs to unique repo slugs (only checkouts with a work signal). */
async function resolveTouchedSlugs(
	dirs: Map<string, { strong: boolean }>,
	resolveRepo: (cwd: string) => Promise<string>,
): Promise<Map<string, string>> {
	const bySlug = new Map<string, string>(); // slug → dir
	for (const [dir, { strong }] of dirs) {
		if (!strong) continue;
		// Bogus candidates (URLs, git refs, typos, non-existent paths) are common
		// in real transcripts — filter to dirs that actually exist BEFORE ever
		// spawning a `gh repo view` subprocess for them.
		let isDir = false;
		try {
			isDir = (await fs.stat(dir)).isDirectory();
		} catch {
			isDir = false;
		}
		if (!isDir) continue;
		try {
			const repo = await resolveRepo(dir);
			if (repo) {
				const slug = sanitizeBankName(repo);
				if (slug && !bySlug.has(slug)) bySlug.set(slug, dir);
			}
		} catch {
			// Not a checkout / no remote — skip.
		}
	}
	return bySlug;
}

async function existingLedgerBlock(ledgerPath: string): Promise<string> {
	let existing: string | undefined;
	try {
		existing = await fs.readFile(ledgerPath, "utf8");
	} catch {
		existing = undefined;
	}
	return existing
		? `The ledger file already exists at ${ledgerPath}. Its current contents:\n\n${existing}`
		: `No ledger file exists yet at ${ledgerPath} — this session is creating it for the first time.`;
}

async function buildSingleRepoPrompt(ledgerPath: string, slug: string, otherRepos: string[]): Promise<string> {
	const existingBlock = await existingLedgerBlock(ledgerPath);
	const focus =
		otherRepos.length > 0
			? `This session also worked on other repos (${otherRepos.join(", ")}). Focus ONLY on work relevant to "${slug}"; ignore changes that belong to the other repos.`
			: "";
	return [
		`You are maintaining a persistent status ledger for the repo "${slug}" across coding-agent sessions.`,
		existingBlock,
		focus,
		"",
		LEDGER_FORMAT_CONTRACT,
		"",
		"Using THIS SESSION's conversation so far, output ONLY the full updated ledger markdown, nothing else.",
		"Merge, don't append blindly; keep entries from other sessions.",
	]
		.filter(Boolean)
		.join("\n");
}

function sanitizeLedgerOutput(raw: string, slug: string): string | undefined {
	const stripped = stripCodeFence(raw);
	if (stripped.startsWith("# ")) return stripped;
	if (stripped.startsWith("## ")) return `# ${slug} — status ledger\n\n${stripped}`;
	return undefined;
}

/** Literal appended by `dedupeEphemeralReply` when it caps a reply — must match agent-session.ts. */
const TRUNCATION_MARKER = "[…truncated]";
/** EPHEMERAL_REPLY_MAX_BYTES (4096) and that cap plus the trailing newline writeLedgerAtomically adds. */
const CAP_BOUNDARY_BYTES = new Set([4096, 4097]);

interface LedgerHeading {
	heading: string;
	index: number;
}

// The ONE heading scan every guard and surgery shares. Regex-only scans
// (`/^#{1,2} /m`) are fence-blind: a fenced ```md sample inside a section
// body whose code contains a `## example` line splits the section at that
// line — hazard extents truncate mid-fence and the heading guard counts a
// spurious section (verified live 2026-07-31: every guard passed on the
// corrupted result). Track ```/~~~ fence state line-by-line and ignore
// heading-looking lines inside a fence. CommonMark closing rules: same
// fence char, run length >= the opening run, nothing else on the line.
function scanLedgerHeadings(text: string): LedgerHeading[] {
	const headings: LedgerHeading[] = [];
	let fenceChar = "";
	let fenceLen = 0;
	let index = 0;
	while (index <= text.length) {
		const newline = text.indexOf("\n", index);
		const end = newline === -1 ? text.length : newline;
		let line = text.slice(index, end);
		// `.` excludes \r, so the old regex scans never saw a CR; strip it to
		// keep heading strings and offsets byte-identical under CRLF.
		if (line.endsWith("\r")) line = line.slice(0, -1);
		const fence = line.match(/^(`{3,}|~{3,})/);
		if (fenceChar === "") {
			if (fence !== null) {
				fenceChar = fence[1][0];
				fenceLen = fence[1].length;
			} else if (/^#{1,2} ./.test(line)) {
				headings.push({ heading: line, index });
			}
		} else if (
			fence !== null &&
			fence[1][0] === fenceChar &&
			fence[1].length >= fenceLen &&
			/^(`+|~+)\s*$/.test(line)
		) {
			fenceChar = "";
			fenceLen = 0;
		}
		if (newline === -1) break;
		index = newline + 1;
	}
	return headings;
}

/** First `## ` section heading (exactly two '#'), fence-aware; the hazards-first slot anchor. */
function firstSectionHeading(text: string): LedgerHeading | undefined {
	return scanLedgerHeadings(text).find(h => h.heading.startsWith("## "));
}

function ledgerHeadings(text: string): Set<string> {
	return new Set(scanLedgerHeadings(text).map(h => h.heading));
}

// The invariant this guard defends is "no SECTION disappears", not "no heading
// is ever reworded". Comparing raw heading strings conflated the two and made
// annotated headings a trap: this repo's own hazard heading reads
// "## Landmines (FIRST on purpose — see ovh-cloud #1201: ...)", so a sync whose
// reply said plain "## Landmines" was scored as DROPPING the section and the
// ledger became unwritable by the background writer — observed live 2026-07-30,
// refusing every sync while the section was in fact present and first.
// Key on the heading's title up to its first annotation delimiter, so a
// reworded parenthetical still matches the section it names.
function headingKey(heading: string): string {
	const title = heading.replace(/^#{1,2} /, "").split(/[(—:]/, 1)[0] ?? "";
	return title.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Counts, not a set: two headings can legitimately share a key
// ("## Landmines" + "## Landmines (infra)"), and a plain set would let one of
// them vanish undetected. A key whose count DROPS is a real lost section.
function headingKeyCounts(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const heading of ledgerHeadings(text)) {
		const key = headingKey(heading);
		if (key !== "") counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

// Section extent by OFFSET: start = the hazard heading, end = the start of the
// NEXT heading line (definition 3 of 3 — the only boundary stable under
// zero/one/two blank-line separators). The search MUST begin past the matched
// heading line: searching from inside it matches the heading's own leading "#"
// and yields a 1-char "section" (masked while the prefix alone exceeded 4096;
// live the moment offsets are computed from the section).
function hazardExtentOf(text: string): { start: number; end: number } | undefined {
	const headings = scanLedgerHeadings(text);
	const hazardIndex = headings.findIndex(h => /^#{1,2} .*(landmine|hazard|⚠).*$/i.test(h.heading));
	if (hazardIndex === -1) return undefined;
	const hazard = headings[hazardIndex];
	const next = headings[hazardIndex + 1];
	return { start: hazard.index, end: next === undefined ? text.length : next.index };
}

const hazardBodyOf = (section: string): string => section.replace(/^[^\n]*\n?/, "");
const bulletsOf = (body: string): string[] => body.match(/^[-*] .*(?:\n(?![-*] |#).*)*/gm) ?? [];
const bulletKey = (bullet: string): string =>
	bullet
		.replace(/\s+/g, " ")
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, "")
		.trim()
		.slice(0, 60);

// Hazards are append-only, enforced BY CONSTRUCTION rather than by refusal.
//
// "Hazards are never compacted by the sync writer" used to be a veto: if the
// model's rewrite had a smaller hazard section, the whole write was dropped.
// On a hazard-heavy ledger that is a deadlock, because a model asked to
// summarise a repo will condense a 13-bullet landmine list every single time —
// agent-chat's own ledger refused with "hazard section shrank (5390 → 4143
// bytes)" on a real 2026-07-30 sync, so the file could never be updated at all
// and the operator's "automatic context in the background" simply did not
// happen for exactly the repos that need it most.
//
// So do not ask the model to be trustworthy with hazards: keep the previous
// hazard body VERBATIM (every bullet, original order) and append only those
// bullets the model genuinely added. Nothing the model omits can be lost, new
// hazards still land, and the shrinkage predicate below becomes an unreachable
// safety net instead of a gate.
function preserveHazards(previous: string, next: string): string {
	const prevExtent = hazardExtentOf(previous);
	const nextExtent = hazardExtentOf(next);
	if (prevExtent === undefined || nextExtent === undefined) return next;
	const prevBody = hazardBodyOf(previous.slice(prevExtent.start, prevExtent.end));
	const nextSection = next.slice(nextExtent.start, nextExtent.end);
	const prevKeys = new Set(bulletsOf(prevBody).map(bulletKey));
	const added = bulletsOf(hazardBodyOf(nextSection)).filter(b => !prevKeys.has(bulletKey(b)));
	const heading = nextSection.slice(0, nextSection.indexOf("\n") + 1) || `${nextSection}\n`;
	const mergedBody = added.length === 0 ? prevBody : `${prevBody.trimEnd()}\n${added.join("\n")}\n\n`;
	return next.slice(0, nextExtent.start) + heading + mergedBody + next.slice(nextExtent.end);
}

// The cut signatures, checked on the RAW reply before any surgery:
// preserveHazards merges bullets (changing byte length) and remediation
// splices whole sections after the hazard block (moving the tail) — either
// would mask the marker-at-tail / exact-boundary signatures these predicates
// exist to catch. Composed into validateLedgerCandidate below so the guard
// and the surgery gate share ONE predicate set.
function cutSignatureOf(candidate: string): string | undefined {
	if (candidate.trimEnd().endsWith(TRUNCATION_MARKER)) {
		return "carries the truncation marker";
	}
	const newBytes = Buffer.byteLength(candidate, "utf8");
	if (CAP_BOUNDARY_BYTES.has(newBytes)) {
		return `lands exactly at the display-cap boundary (${newBytes} bytes)`;
	}
	return undefined;
}

// Defense in depth, not redundancy: the call site opts out of the ephemeral
// display cap via `dedupeReply: false`, but this reply is still model output
// written to a FILE. Any path that reintroduces a cut (a future call site, a
// provider-side cap, a model echoing the marker) would silently replace a
// whole ledger with a severed stub — and the next sync would treat the stub
// as the file. Refuse the write and keep the previous ledger; the warn is
// the signal the cut otherwise never emits. Four predicates, each mapped to
// an observed 07-29 failure, ALL MEASURED IN BYTES (the cap is a byte cap;
// a 14-bullet ⚠️ section hides ~56 bytes in the markers alone — char counts
// fail open exactly where the margin is thinnest):
//  1. marker — the dedupeEphemeralReply signature (8 ledgers cut in one night).
//  2. cap boundary — a marker-less prefix cut lands at exactly 4096/4097 bytes.
//  3. heading shrinkage — a prefix cut or wholesale mangling that drops a
//     section the current file has (landing-pages lost Landmines this way).
//  4. hazards window — a WHOLESALE REWRITE can reorder sections without
//     dropping any heading; if the hazard section ends past the 4096-byte
//     window a later cut eats it with every other check green (two instances).
//     Boundary: start of the NEXT heading line — the only boundary stable under
//     zero/one/two blank-line separators (iss-scheduling #1372).
// `previous` is the on-disk ledger, or "" when the file is being created — the
// heading-drop and hazard-shrinkage predicates then vacuously pass, exactly
// matching the old `priorLedger === undefined` fast path.
// Returns the refusal reason, or undefined when the candidate is writable.
export function validateLedgerCandidate(previous: string, candidate: string): string | undefined {
	const cut = cutSignatureOf(candidate);
	if (cut !== undefined) return cut;
	const priorCounts = headingKeyCounts(previous);
	const nextCounts = headingKeyCounts(candidate);
	const dropped = [...ledgerHeadings(previous)].filter(
		h => (nextCounts.get(headingKey(h)) ?? 0) < (priorCounts.get(headingKey(h)) ?? 0),
	);
	if (dropped.length > 0) {
		return `drops ${dropped.length} existing heading(s): ${dropped.slice(0, 3).join(" | ")}`;
	}
	// 4. hazards POSITION, not hazards BUDGET (rewritten 2026-07-30).
	//    Was: refuse if the hazard section ends past byte 4096. That framing
	//    came from the era when a later 4096-byte cut could eat anything past
	//    the window. The cut path is fixed (f1f7fd484 — the ephemeral display
	//    cap no longer reaches ledger file writes) and predicates 1 and 2 still
	//    catch a cut if one reappears, but as a REFUSAL the byte rule did active
	//    harm: any ledger whose hazards legitimately grow past 4096 bytes became
	//    permanently unwritable by the sync writer. Observed live on
	//    Family-Fun-Group-Husbandry_App.md (hazards end at byte 7301; 54 syncs
	//    ran, every one refused, each reporting `done` with tokens billed while
	//    the file never changed), with Family-Fun-Group-landing-pages.md 5 bytes
	//    from the same cliff. It also contradicted the operator directive of
	//    record: ledgers are NOT byte-capped, and a ledger must never be
	//    contorted to fit a margin.
	//    What the old rule was really protecting against is a rewrite that
	//    REORDERS hazards away from the top. So check that directly, the same
	//    way agent-chat's own `ledger-guard check` does: the hazard heading must
	//    be the FIRST `##` section in the file. Position is the invariant; bytes
	//    are now only a warning (emitted by the caller, who has the logger).
	const extent = hazardExtentOf(candidate);
	const firstSection = firstSectionHeading(candidate);
	if (extent !== undefined && firstSection !== undefined && extent.start > firstSection.index) {
		return `hazard section is not the first '##' section (hazards-first is positional; first section is ${JSON.stringify(firstSection.heading)})`;
	}
	// 5. hazard shrinkage — hazards are NEVER compactable (operator directive;
	//    a deliberate condensation is an owner's edit, not the sync writer's).
	//    A semantic rewrite can drop a load-bearing clause while keeping the
	//    heading, offset and structure all valid (observed: Husbandry_App lost
	//    its search_path re-arm trigger with every check green). Smaller = refuse.
	//    Measured on the section BODY, never including the heading line: the
	//    heading can carry a long annotation ("## Landmines (FIRST on purpose
	//    — see ovh-cloud #1201)"), and counting it meant shortening that
	//    annotation registered as lost hazard content even when the reply ADDED
	//    bullets — the second half of the 2026-07-30 unwritable-ledger bug.
	if (extent !== undefined) {
		const prevExtent = hazardExtentOf(previous);
		if (prevExtent !== undefined) {
			const nextBytes = Buffer.byteLength(hazardBodyOf(candidate.slice(extent.start, extent.end)), "utf8");
			const prevBytes = Buffer.byteLength(hazardBodyOf(previous.slice(prevExtent.start, prevExtent.end)), "utf8");
			if (nextBytes < prevBytes) {
				return `hazard section shrank (${prevBytes} → ${nextBytes} bytes); hazards are never compacted by the sync writer`;
			}
		}
	}
	return undefined;
}

/** Extent of the section whose heading line starts at `headingIndex` (end = next heading or EOF). */
function sectionExtentAt(text: string, headingIndex: number): { start: number; end: number } {
	const headingEnd = text.indexOf("\n", headingIndex);
	const bodyStart = headingEnd === -1 ? text.length : headingEnd + 1;
	const next = scanLedgerHeadings(text).find(h => h.index >= bodyStart);
	return { start: headingIndex, end: next === undefined ? text.length : next.index };
}

/** Insert `section` (pre-trimmed) immediately before the first `##` heading —
 * the hazards-first slot. Inserting directly after the `#` title line would
 * displace any preamble between title and first section INTO the moved hazard
 * extent (live defect: three ledgers refused repair on the byte-identity
 * assert). Title and preamble stay put; hazards become the first `##`. */
function insertAfterTitleBlock(text: string, section: string): string {
	const first = firstSectionHeading(text);
	if (first === undefined) {
		const trimmed = text.replace(/\s+$/, "");
		return trimmed === "" ? `${section}\n` : `${trimmed}\n\n${section}\n`;
	}
	const head = text.slice(0, first.index).replace(/\s+$/, "");
	const tail = text.slice(first.index);
	return `${head}\n\n${section}\n\n${tail}`;
}

// Hazards-first is positional: a wholesale rewrite that REORDERS the hazard
// section away from the top used to be refuse-only, but the fix is pure
// cut-and-paste with in-memory data — the section bytes exist, just in the
// wrong slot. Move the whole extent (heading + body, byte-identical) to
// immediately after the `#` title block.
function moveHazardsFirst(text: string): string {
	const extent = hazardExtentOf(text);
	if (extent === undefined) return text;
	const firstSection = firstSectionHeading(text);
	if (firstSection === undefined || extent.start <= firstSection.index) return text;
	const section = text.slice(extent.start, extent.end).replace(/\s+$/, "");
	const rest = text.slice(0, extent.start) + text.slice(extent.end);
	return insertAfterTitleBlock(rest, section);
}

// A dropped heading is recoverable for the same reason: the section bytes are
// still in `previous`. Restore each dropped occurrence VERBATIM, in previous
// document order (so an earlier restore can anchor a later one), spliced after
// the nearest preceding section that survived into the candidate — the slot it
// came from. Sections are cut and spliced, never rewritten.
function restoreDroppedSections(previous: string, candidate: string): string {
	const prevHeadings = scanLedgerHeadings(previous);
	const nextCounts = headingKeyCounts(candidate);
	const seen = new Map<string, number>();
	const droppedIndexes: number[] = [];
	for (const { heading, index } of prevHeadings) {
		const key = headingKey(heading);
		if (key === "") continue;
		const occurrence = (seen.get(key) ?? 0) + 1;
		seen.set(key, occurrence);
		if (occurrence > (nextCounts.get(key) ?? 0)) droppedIndexes.push(index);
	}
	let result = candidate;
	for (const index of droppedIndexes) {
		const extent = sectionExtentAt(previous, index);
		const section = previous.slice(extent.start, extent.end).replace(/\s+$/, "");
		// Anchor: the nearest PRECEDING section in `previous` that is present in
		// the candidate. Fall back to the title block when none survives.
		let anchorKey = "";
		const resultCounts = headingKeyCounts(result);
		for (const { heading, index: headingIndex } of prevHeadings) {
			if (headingIndex >= index) break;
			const key = headingKey(heading);
			if (key !== "" && (resultCounts.get(key) ?? 0) > 0) anchorKey = key;
		}
		let insertAt: number | undefined;
		if (anchorKey !== "") {
			for (const { heading, index: headingIndex } of scanLedgerHeadings(result)) {
				if (headingKey(heading) === anchorKey) {
					insertAt = sectionExtentAt(result, headingIndex).end;
				}
			}
		}
		if (insertAt === undefined) {
			result = insertAfterTitleBlock(result, section);
			continue;
		}
		const before = result.slice(0, insertAt).replace(/\s+$/, "");
		const after = result.slice(insertAt).replace(/^\s+/, "");
		result = after === "" ? `${before}\n\n${section}\n` : `${before}\n\n${section}\n\n${after}`;
	}
	return result;
}

// Deterministic in-memory surgery on the model's candidate, run by the sync
// writer BETWEEN preserveHazards and the guard: (a) hazards-not-first → move
// the hazard extent to the first `##` slot; (b) a section whose heading count
// dropped vs `previous` → splice it back verbatim from `previous`. Both fixes
// are cut-and-paste from bytes that already exist; anything not representable
// that way (a truncation-marker stub, a cap-boundary cut, no hazard section
// anywhere) is left for validateLedgerCandidate to refuse.
export function remediateCandidate(previous: string, candidate: string): string {
	// Never operate on a cut-suspect candidate: splicing a restored section
	// AFTER a truncation marker (or padding a cap-boundary cut off the exact
	// boundary) would mask the signatures the guard refuses on. Those classes
	// are retry-only — the lost bytes exist nowhere.
	if (cutSignatureOf(candidate) !== undefined) return candidate;
	return restoreDroppedSections(previous, moveHazardsFirst(candidate));
}

async function writeLedgerAtomically(ledgerPath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
	const tmpPath = `${ledgerPath}.tmp-${Bun.randomUUIDv7()}`;
	try {
		await fs.writeFile(tmpPath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
		await fs.rename(tmpPath, ledgerPath);
	} catch (error) {
		await fs.rm(tmpPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export interface LedgerRepairResult {
	repaired: boolean;
	reason?: string;
}

/** Non-blank lines, sorted — identity under pure reordering, intolerance to
 * any added/dropped/edited content line. */
function nonBlankLineMultiset(text: string): string[] {
	return text
		.split("\n")
		.filter(line => line.trim() !== "")
		.sort();
}

/** True when `after` is `before` up to reordering and blank-line count
 * changes only (the separator re-normalization a section move performs). */
function sameContentLines(before: string, after: string): boolean {
	const a = nonBlankLineMultiset(before);
	const b = nonBlankLineMultiset(after);
	return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * LLM-free on-disk self-repair (`loom sync-context --repair`). Reads the
 * ledger, runs the same remediation the sync writer runs in-memory
 * (previous === candidate === the file, so only hazards-not-first is
 * repairable this way — nothing can have "dropped" relative to itself), then
 * validates the result. Refuse on ambiguity: a ledger with NO hazard section
 * at all is an owner's decision, not the repairer's, and the hazard bytes
 * must survive the move exactly (cut-and-paste, never a rewrite). Two
 * defense-in-depth asserts sit behind validation — the remediated document
 * must be the original up to reordering and blank separators (sorted
 * non-blank line multiset), and the file is re-read immediately before the
 * atomic write so a concurrent sync write is never clobbered (returns
 * "ledger changed during repair; rerun"). `deps.remediate` is a test seam
 * for doctoring the in-memory remediation; production callers omit it.
 */
export async function repairLedgerOnDisk(
	ledgerPath: string,
	opts: { dryRun: boolean },
	deps: { remediate?: (previous: string, candidate: string) => string } = {},
): Promise<LedgerRepairResult> {
	const content = await fs.readFile(ledgerPath, "utf8");
	const extentBefore = hazardExtentOf(content);
	if (extentBefore === undefined) return { repaired: false, reason: "no hazards section" };
	const remediated = (deps.remediate ?? remediateCandidate)(content, content);
	const refuseReason = validateLedgerCandidate(content, remediated);
	if (refuseReason !== undefined) return { repaired: false, reason: refuseReason };
	// Byte-identity assert: trailing blank separators at the splice joint are
	// re-normalized by the move and are not hazard content; everything else must
	// be the exact same bytes.
	const hazardsBefore = content.slice(extentBefore.start, extentBefore.end).replace(/\s+$/, "");
	const extentAfter = hazardExtentOf(remediated);
	const hazardsAfter =
		extentAfter === undefined ? "" : remediated.slice(extentAfter.start, extentAfter.end).replace(/\s+$/, "");
	if (hazardsAfter !== hazardsBefore) {
		return { repaired: false, reason: "hazard content changed during move; refusing" };
	}
	// Whole-document line-multiset assert (defense-in-depth behind the
	// hazard-byte assert): remediation is cut-and-paste, so the result must be
	// the original up to reordering and blank separators. Anything else — a
	// fence-split section, an edited line, a duplicated splice — is a bug in
	// the surgery, not a repair, and must never reach disk.
	if (!sameContentLines(content, remediated)) {
		return { repaired: false, reason: "remediation changed ledger content lines; refusing" };
	}
	if (remediated === content) return { repaired: false, reason: "valid; nothing to repair" };
	if (opts.dryRun) return { repaired: false, reason: "dry-run: would repair" };
	// TOCTOU guard: a syncSingleRepo write landing between our read and the
	// atomic rename would be silently overwritten with a reorder of stale
	// bytes. Re-read and bail (the caller reruns on its next pass) rather than
	// clobber a fresher ledger.
	const reread = await fs.readFile(ledgerPath, "utf8");
	if (reread !== content) return { repaired: false, reason: "ledger changed during repair; rerun" };
	await writeLedgerAtomically(ledgerPath, remediated);
	return { repaired: true };
}

/** Per-repo `runEphemeralTurn` usage, captured for the Context Activity `done` event. */
interface SyncRepoResult {
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	model?: string;
	provider?: string;
	durationMs: number;
	/**
	 * Ledgers this attempt deliberately did NOT write, as "<slug>: <reason>".
	 * A refusal spends tokens and completes without error, so without this it
	 * is indistinguishable from a successful sync at every layer above —
	 * agent-chat's Context Activity row said `done` with a cost attached while
	 * the file never changed (observed live: Family-Fun-Group-Husbandry_App,
	 * refused on every one of 54 syncs by the since-downgraded hazard-window
	 * predicate, silently, for days). Surfaced so the caller can report it.
	 */
	refusals: string[];
}

const EMPTY_SYNC_RESULT: SyncRepoResult = { tokensIn: 0, tokensOut: 0, cacheRead: 0, durationMs: 0, refusals: [] };

function sumSyncResults(results: readonly SyncRepoResult[]): SyncRepoResult {
	const totals: SyncRepoResult = { ...EMPTY_SYNC_RESULT, refusals: [] };
	for (const result of results) {
		totals.tokensIn += result.tokensIn;
		totals.tokensOut += result.tokensOut;
		totals.cacheRead += result.cacheRead;
		totals.durationMs += result.durationMs;
		totals.model ??= result.model;
		totals.provider ??= result.provider;
		totals.refusals.push(...result.refusals);
	}
	return totals;
}

/** Refusal classes worth ONE retry of the same ephemeral turn — the corrupt bytes exist nowhere, so remediation cannot fix them and only a fresh decode can. */
const RETRIABLE_REFUSAL_PREFIXES: readonly string[] = [
	"model output missing a heading",
	"carries the truncation marker",
	"lands exactly at the display-cap boundary",
];

async function syncSingleRepo(
	session: SessionContextSyncSession,
	ledgerDir: string,
	slug: string,
	otherRepos: string[] = [],
): Promise<SyncRepoResult> {
	const ledgerPath = path.join(ledgerDir, `${slug}.md`);
	const promptText = await buildSingleRepoPrompt(ledgerPath, slug, otherRepos);
	const priorLedger = await fs.readFile(ledgerPath, "utf8").catch(() => undefined);
	const usage: SyncRepoResult = {
		tokensIn: 0,
		tokensOut: 0,
		cacheRead: 0,
		durationMs: 0,
		refusals: [],
	};
	let sanitized: string | undefined;
	let refuseReason: string | undefined;
	// Retry-once: the missing-heading, truncation-marker and cap-boundary
	// classes are transient model-output failures the SAME prompt commonly
	// succeeds on (nondeterministic decode; the lost bytes exist nowhere, so
	// surgery cannot fix them). A refusal still standing AFTER remediation is
	// structural and would just fail again — never retried.
	for (let attempt = 0; attempt < 2; attempt++) {
		const { replyText, assistantMessage } = await session.runEphemeralTurn({ promptText, dedupeReply: false });
		usage.tokensIn += assistantMessage?.usage?.input ?? 0;
		usage.tokensOut += assistantMessage?.usage?.output ?? 0;
		usage.cacheRead += assistantMessage?.usage?.cacheRead ?? 0;
		usage.durationMs += assistantMessage?.duration ?? 0;
		usage.model = assistantMessage?.model ?? usage.model;
		usage.provider = assistantMessage?.provider ?? usage.provider;
		sanitized = sanitizeLedgerOutput(replyText, slug);
		if (sanitized === undefined) {
			refuseReason = "model output missing a heading";
		} else {
			// Cut signatures are judged on the RAW reply, before any surgery
			// could mask them (see cutSignatureOf). Only a signature-clean reply
			// earns remediation: hazards come from the previous file, not the
			// model (see preserveHazards); then deterministic cut-and-paste
			// surgery fixes what the model garbled structurally (hazards
			// reordered away from the top, a dropped section) before the guard
			// judges — preserveHazards → remediate → validate.
			refuseReason = cutSignatureOf(sanitized);
			if (refuseReason === undefined) {
				if (priorLedger !== undefined) sanitized = preserveHazards(priorLedger, sanitized);
				sanitized = remediateCandidate(priorLedger ?? "", sanitized);
				refuseReason = validateLedgerCandidate(priorLedger ?? "", sanitized);
			}
		}
		if (refuseReason === undefined) break;
		const failedReason = refuseReason;
		if (attempt === 0 && RETRIABLE_REFUSAL_PREFIXES.some(prefix => failedReason.startsWith(prefix))) {
			logger.warn("[sessionContextSync] transient ledger output failure; retrying the ephemeral turn once", {
				ledgerPath,
				sessionId: session.sessionId,
				reason: failedReason,
			});
			continue;
		}
		break;
	}
	if (refuseReason !== undefined || sanitized === undefined) {
		if (sanitized === undefined) {
			logger.warn("[sessionContextSync] model output missing a heading; skipping ledger write", {
				ledgerPath,
				sessionId: session.sessionId,
			});
		} else {
			logger.warn(
				"[sessionContextSync] refusing to write a ledger that fails a cut-invariant; keeping previous file",
				{
					ledgerPath,
					sessionId: session.sessionId,
					reason: refuseReason,
					bytes: Buffer.byteLength(sanitized, "utf8"),
				},
			);
		}
		usage.refusals.push(`${slug}: ${refuseReason ?? "model output missing a heading"}`);
		return usage;
	}
	// Warn-only legacy window: hazards legitimately ending past byte 4096 are a
	// NORMAL busy-repo state and must persist ("do not contort a ledger to fit
	// a margin") — position is the invariant (validateLedgerCandidate), bytes
	// only merit a warn.
	const hazardExtent = hazardExtentOf(sanitized);
	if (hazardExtent !== undefined && Buffer.byteLength(sanitized.slice(0, hazardExtent.end), "utf8") > 4096) {
		logger.warn("[sessionContextSync] hazard section ends past the legacy 4096-byte window; writing anyway", {
			ledgerPath,
			sessionId: session.sessionId,
			hazardEndsAtByte: Buffer.byteLength(sanitized.slice(0, hazardExtent.end), "utf8"),
		});
	}
	await writeLedgerAtomically(ledgerPath, sanitized);
	return usage;
}

/**
 * One focused single-repo turn per touched repo, run in PARALLEL. Each
 * `runEphemeralTurn` is an independent side-channel call (unique side session
 * id, no shared mutable turn state), so concurrency is safe and keeps total
 * wall-time ~one turn — important because the shutdown sync runs under a bounded
 * dispose timeout. Reuses the proven fence-tolerant single-repo path; far more
 * robust than one turn emitting a JSON map of multi-line markdown values. A
 * failure on one repo never blocks the others.
 */
async function syncMultiRepo(
	session: SessionContextSyncSession,
	ledgerDir: string,
	slugToDir: Map<string, string>,
): Promise<SyncRepoResult> {
	const slugs = [...slugToDir.keys()];
	const results = await Promise.all(
		slugs.map(async slug => {
			try {
				return await syncSingleRepo(
					session,
					ledgerDir,
					slug,
					slugs.filter(s => s !== slug),
				);
			} catch (error) {
				logger.warn("[sessionContextSync] per-repo sync failed", { slug, error: String(error) });
				// Not silently dropped: one repo throwing while its siblings
				// succeed still means THIS ledger did not get written, and the
				// aggregate event would otherwise report an unqualified `done`.
				return { ...EMPTY_SYNC_RESULT, refusals: [`${slug}: sync threw — ${String(error)}`] };
			}
		}),
	);
	return sumSyncResults(results.filter((r): r is SyncRepoResult => r !== undefined));
}

export interface RunSyncResult extends SyncRepoResult {
	repos: string[];
}

async function runSync(
	session: SessionContextSyncSession,
	settings: SessionContextSyncSettings,
	deps: SessionContextSyncDeps,
): Promise<RunSyncResult> {
	const resolveRepo = deps.resolveRepo ?? (cwd => resolveDefaultRepoMemoized(cwd));
	const ledgerDir = expandTilde(settings.dir);

	// Single-repo mode: cwd is itself a checkout → one ledger, unchanged behavior.
	let cwdSlug: string | undefined;
	try {
		const repo = await resolveRepo(session.cwd);
		if (repo) cwdSlug = repo.replaceAll("/", "-");
	} catch {
		cwdSlug = undefined;
	}
	if (cwdSlug) {
		const result = await syncSingleRepo(session, ledgerDir, cwdSlug);
		return { repos: [cwdSlug], ...result };
	}

	// Multi-repo mode: cwd is a container (e.g. ~/workspace). Detect touched repos.
	const workspaceRoot = settings.workspaceRoot ? expandTilde(settings.workspaceRoot) : session.cwd;
	const messages = session.messages ?? [];
	const dirs = touchedRepoDirs(messages, workspaceRoot);
	let slugToDir = await resolveTouchedSlugs(dirs, resolveRepo);

	if (slugToDir.size > MAX_REPOS_PER_SYNC) {
		logger.warn("[sessionContextSync] more repos touched than cap; syncing first N", {
			touched: slugToDir.size,
			cap: MAX_REPOS_PER_SYNC,
		});
		slugToDir = new Map([...slugToDir].slice(0, MAX_REPOS_PER_SYNC));
	}

	if (slugToDir.size === 0) {
		// Nothing resolves to a GitHub repo. The only basename ledger worth
		// keeping is the workspace root's own (the container-level context
		// agent-chat's SPAWNING.md documents); any other cwd basename —
		// scratch dirs, worktree ids, temp names — would mint a ledger file
		// for a repo that does not exist, and those sessions' durable facts
		// live in mnemopi, not in a ledger. Skip instead of minting duds
		// (agent-chat context purge 2026-08-23: 64 such files archived).
		const cwd = path.resolve(session.cwd);
		const root = settings.workspaceRoot ? path.resolve(expandTilde(settings.workspaceRoot)) : cwd;
		if (cwd === root) {
			const slug = path.basename(cwd) || "session";
			const result = await syncSingleRepo(session, ledgerDir, slug);
			return { repos: [slug], ...result };
		}
		return { repos: [], ...EMPTY_SYNC_RESULT };
	}
	if (slugToDir.size === 1) {
		const [slug] = slugToDir.keys();
		const result = await syncSingleRepo(session, ledgerDir, slug);
		return { repos: [slug], ...result };
	}
	const result = await syncMultiRepo(session, ledgerDir, slugToDir);
	return { repos: [...slugToDir.keys()], ...result };
}

/**
 * LLM-free repo detection: the same resolution logic `runSync` uses (cwd
 * single-repo fast path, else multi-repo touched-dir scan) but never calls
 * `runEphemeralTurn`. Cheap enough to run inline at session dispose — used
 * for the shutdown-handoff spool record's `repos[]`.
 */
export async function detectTouchedRepos(
	session: SessionContextSyncSession,
	settings: SessionContextSyncSettings,
	deps: SessionContextSyncDeps = {},
): Promise<string[]> {
	const resolveRepo = deps.resolveRepo ?? (cwd => resolveDefaultRepoMemoized(cwd));
	try {
		const repo = await resolveRepo(session.cwd);
		if (repo) {
			const slug = sanitizeBankName(repo);
			if (slug) return [slug];
		}
	} catch {
		// Not a checkout — fall through to multi-repo detection.
	}
	const workspaceRoot = settings.workspaceRoot ? expandTilde(settings.workspaceRoot) : session.cwd;
	const dirs = touchedRepoDirs(session.messages ?? [], workspaceRoot);
	const slugToDir = await resolveTouchedSlugs(dirs, resolveRepo);
	return [...slugToDir.keys()];
}

/**
 * Pause/throttle gate: read before spending tokens. Missing/unreadable/
 * malformed file is treated as not-paused — the gate must never throw and
 * must fail open when agent-chat (or its control file) is unavailable.
 */
async function isSyncPaused(controlFile: string): Promise<boolean> {
	if (!controlFile) return false;
	try {
		const raw = await fs.readFile(expandTilde(controlFile), "utf8");
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) && parsed.paused === true;
	} catch {
		return false;
	}
}

/** Atomic (tmp + rename) spool write — same crash-safety idiom as `writeLedgerAtomically`. */
export async function writeSpoolRecordAtomically(spoolDir: string, record: ContextSyncSpoolRequest): Promise<void> {
	const dir = expandTilde(spoolDir);
	await fs.mkdir(dir, { recursive: true });
	const finalPath = path.join(dir, `${record.sessionId}-${Bun.randomUUIDv7()}.json`);
	const tmpPath = `${finalPath}.tmp-${Bun.randomUUIDv7()}`;
	try {
		await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		await fs.rename(tmpPath, finalPath);
	} catch (error) {
		await fs.rm(tmpPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

/**
 * Sync per-repo status ledger(s) from this session's transcript. No-op
 * unless `sessionContextSync.enabled` and `.dir` are both configured. Skips
 * if a sync is already in flight, or (except on `shutdown`) if the last
 * sync happened within `minIntervalSeconds`, or if `controlFile` says the
 * system is paused. Reports a Context Activity `sync` event
 * (start/done/skip/fail) at `settings.reportUrl` on every path. Never throws.
 */
export async function maybeSync(
	session: SessionContextSyncSession,
	reason: SessionContextSyncReason,
	deps: SessionContextSyncDeps = {},
): Promise<void> {
	const activityId = deps.activityId ?? Bun.randomUUIDv7();
	const now = deps.now ?? Date.now;
	let settings: SessionContextSyncSettings | undefined;
	const emit = (phase: ContextActivityPhase, extra: Partial<ContextActivityEvent> = {}) => {
		const reportUrl = settings?.reportUrl;
		// The default (module-internal) HTTP reporter only fires once this
		// session has actually opted into sessionContextSync — otherwise the
		// "disabled" skip emitted below would defeat this module's documented
		// "total no-op unless enabled+dir configured" invariant by POSTing a
		// meaningless skip row to agent-chat's default reportUrl on every idle
		// timeout/compaction for every loom session, opted in or not. An
		// explicit `deps.reportEvent` (the `sync-context` CLI, tests) still
		// always receives the event — it needs the terminal outcome even when
		// the feature is off.
		const reportEvent =
			deps.reportEvent ??
			(reportUrl && settings?.enabled
				? (event: ContextActivityEvent) => reportContextActivity(event, reportUrl)
				: undefined);
		reportEvent?.({
			id: activityId,
			kind: "sync",
			phase,
			session_id: session.sessionId ?? "",
			session_label: session.sessionLabel,
			transcript_path: session.transcriptPath,
			trigger: reason,
			ts: now(),
			...extra,
		});
	};

	try {
		settings = session.settings?.getGroup("sessionContextSync");
		if (!settings?.enabled || !settings.dir) {
			emit("skip", { error: "disabled" });
			return;
		}
		if (session.messages && session.messages.length === 0) {
			emit("skip", { error: "empty" });
			return;
		}

		const state = syncStates.get(session) ?? { lastSyncAt: 0, inFlight: false };
		syncStates.set(session, state);
		if (state.inFlight) {
			emit("skip", { error: "inflight" });
			return;
		}

		if (reason !== "shutdown") {
			const minIntervalMs = Math.max(0, settings.minIntervalSeconds) * 1000;
			if (now() - state.lastSyncAt < minIntervalMs) {
				emit("skip", { error: "debounce" });
				return;
			}
		}

		state.inFlight = true;
		try {
			if (await isSyncPaused(settings.controlFile)) {
				emit("skip", { error: "paused" });
				return;
			}

			emit("start");
			const result = await runSync(session, settings, deps);
			state.lastSyncAt = now();
			// A refusal spends tokens and returns cleanly, so reporting an
			// unqualified `done` made a no-write indistinguishable from a real
			// sync — agent-chat's dashboard showed `done` with a cost attached
			// while the ledger was untouched (Husbandry_App: 54 consecutive
			// silent no-writes). The terminal event therefore stays `done` (the
			// sync ran to completion) but carries the write outcome explicitly:
			// `persisted` when at least one ledger landed, `refused` when every
			// write was refused, `skipped` when nothing was there to sync (no
			// canonical repo slug resolved and cwd was not the workspace root),
			// with the exact per-ledger guard reasons in `refuse_reason`
			// (`error` kept for older ingests).
			const wroteNothing =
				result.repos.length === 0 || (result.refusals.length > 0 && result.refusals.length >= result.repos.length);
			emit("done", {
				repos: result.repos,
				tokens_in: result.tokensIn,
				tokens_out: result.tokensOut,
				cache_read: result.cacheRead,
				model: result.model,
				provider: result.provider,
				duration_ms: result.durationMs,
				outcome: result.repos.length === 0 ? "skipped" : wroteNothing ? "refused" : "persisted",
				...(result.refusals.length > 0
					? {
							error: `ledger not written — ${result.refusals.join("; ")}`,
							refuse_reason: result.refusals.join("; "),
						}
					: {}),
			});
		} finally {
			state.inFlight = false;
		}
	} catch (error) {
		logger.warn("[sessionContextSync] sync failed", { reason, error: String(error) });
		emit("fail", { error: String(error) });
	}
}

export const SessionContextSync = { maybeSync };
