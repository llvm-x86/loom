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
- "## Current state" — a short prose/bullet summary of where the repo/work stands.
- "## Recent changes (newest first, keep ~10)" — bullet list, each line
  "- YYYY-MM-DD <session>: what happened + a ref (file, PR, issue, commit)".
  Keep roughly the 10 most recent entries; drop the oldest when adding a new one.
- "## In flight" — work that is currently in progress, not yet landed.
- "## Landmines" — known gotchas, footguns, or things a future session must not repeat.
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
				const slug = repo.replaceAll("/", "-");
				if (!bySlug.has(slug)) bySlug.set(slug, dir);
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

/** Per-repo `runEphemeralTurn` usage, captured for the Context Activity `done` event. */
interface SyncRepoResult {
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	model?: string;
	provider?: string;
	durationMs: number;
}

const EMPTY_SYNC_RESULT: SyncRepoResult = { tokensIn: 0, tokensOut: 0, cacheRead: 0, durationMs: 0 };

function sumSyncResults(results: readonly SyncRepoResult[]): SyncRepoResult {
	const totals: SyncRepoResult = { ...EMPTY_SYNC_RESULT };
	for (const result of results) {
		totals.tokensIn += result.tokensIn;
		totals.tokensOut += result.tokensOut;
		totals.cacheRead += result.cacheRead;
		totals.durationMs += result.durationMs;
		totals.model ??= result.model;
		totals.provider ??= result.provider;
	}
	return totals;
}

async function syncSingleRepo(
	session: SessionContextSyncSession,
	ledgerDir: string,
	slug: string,
	otherRepos: string[] = [],
): Promise<SyncRepoResult> {
	const ledgerPath = path.join(ledgerDir, `${slug}.md`);
	const promptText = await buildSingleRepoPrompt(ledgerPath, slug, otherRepos);
	const { replyText, assistantMessage } = await session.runEphemeralTurn({ promptText });
	const usage: SyncRepoResult = {
		tokensIn: assistantMessage?.usage?.input ?? 0,
		tokensOut: assistantMessage?.usage?.output ?? 0,
		cacheRead: assistantMessage?.usage?.cacheRead ?? 0,
		model: assistantMessage?.model,
		provider: assistantMessage?.provider,
		durationMs: assistantMessage?.duration ?? 0,
	};
	const sanitized = sanitizeLedgerOutput(replyText, slug);
	if (!sanitized) {
		logger.warn("[sessionContextSync] model output missing a heading; skipping ledger write", {
			ledgerPath,
			sessionId: session.sessionId,
		});
		return usage;
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
				return undefined;
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
		// Nothing detectable — fall back to a single cwd-basename ledger.
		const slug = path.basename(path.resolve(session.cwd)) || "session";
		const result = await syncSingleRepo(session, ledgerDir, slug);
		return { repos: [slug], ...result };
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
		if (repo) return [repo.replaceAll("/", "-")];
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
			emit("done", {
				repos: result.repos,
				tokens_in: result.tokensIn,
				tokens_out: result.tokensOut,
				cache_read: result.cacheRead,
				model: result.model,
				provider: result.provider,
				duration_ms: result.durationMs,
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
