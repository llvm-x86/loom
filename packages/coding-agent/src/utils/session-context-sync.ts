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

export type SessionContextSyncReason = "compaction" | "shutdown" | "idle";

export interface SessionContextSyncSettings {
	enabled: boolean;
	dir: string;
	idleMinutes: number;
	minIntervalSeconds: number;
	/** Container dir under which repos live (multi-repo mode). Empty → use cwd. */
	workspaceRoot: string;
}

/** Minimal duck-typed surface `AgentSession` satisfies; kept narrow for testability. */
export interface SessionContextSyncSession {
	readonly cwd: string;
	readonly sessionId?: string;
	readonly settings?: { getGroup(prefix: "sessionContextSync"): SessionContextSyncSettings };
	readonly messages?: readonly unknown[];
	runEphemeralTurn(args: { promptText: string; signal?: AbortSignal }): Promise<{ replyText: string }>;
}

export interface SessionContextSyncDeps {
	/** Overridable for tests; defaults to the real `gh`-backed resolver. */
	resolveRepo?: (cwd: string) => Promise<string>;
	now?: () => number;
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

async function syncSingleRepo(
	session: SessionContextSyncSession,
	ledgerDir: string,
	slug: string,
	otherRepos: string[] = [],
): Promise<void> {
	const ledgerPath = path.join(ledgerDir, `${slug}.md`);
	const promptText = await buildSingleRepoPrompt(ledgerPath, slug, otherRepos);
	const { replyText } = await session.runEphemeralTurn({ promptText });
	const sanitized = sanitizeLedgerOutput(replyText, slug);
	if (!sanitized) {
		logger.warn("[sessionContextSync] model output missing a heading; skipping ledger write", {
			ledgerPath,
			sessionId: session.sessionId,
		});
		return;
	}
	await writeLedgerAtomically(ledgerPath, sanitized);
}

/**
 * One focused single-repo turn per touched repo. Sequential and reuses the
 * proven single-repo prompt/sanitize path — far more robust than asking one
 * turn to emit a JSON map of multi-line markdown values (models mangle that).
 */
async function syncMultiRepo(
	session: SessionContextSyncSession,
	ledgerDir: string,
	slugToDir: Map<string, string>,
): Promise<void> {
	const slugs = [...slugToDir.keys()];
	for (const slug of slugs) {
		const otherRepos = slugs.filter(s => s !== slug);
		await syncSingleRepo(session, ledgerDir, slug, otherRepos);
	}
}

async function runSync(
	session: SessionContextSyncSession,
	settings: SessionContextSyncSettings,
	deps: SessionContextSyncDeps,
): Promise<void> {
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
		await syncSingleRepo(session, ledgerDir, cwdSlug);
		return;
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
		await syncSingleRepo(session, ledgerDir, slug);
		return;
	}
	if (slugToDir.size === 1) {
		const [slug] = slugToDir.keys();
		await syncSingleRepo(session, ledgerDir, slug);
		return;
	}
	await syncMultiRepo(session, ledgerDir, slugToDir);
}

/**
 * Sync per-repo status ledger(s) from this session's transcript. No-op
 * unless `sessionContextSync.enabled` and `.dir` are both configured. Skips
 * if a sync is already in flight, or (except on `shutdown`) if the last
 * sync happened within `minIntervalSeconds`. Never throws.
 */
export async function maybeSync(
	session: SessionContextSyncSession,
	reason: SessionContextSyncReason,
	deps: SessionContextSyncDeps = {},
): Promise<void> {
	try {
		const settings = session.settings?.getGroup("sessionContextSync");
		if (!settings?.enabled || !settings.dir) return;
		if (session.messages && session.messages.length === 0) return;

		const state = syncStates.get(session) ?? { lastSyncAt: 0, inFlight: false };
		syncStates.set(session, state);
		if (state.inFlight) return;

		const now = deps.now ?? Date.now;
		if (reason !== "shutdown") {
			const minIntervalMs = Math.max(0, settings.minIntervalSeconds) * 1000;
			if (now() - state.lastSyncAt < minIntervalMs) return;
		}

		state.inFlight = true;
		try {
			await runSync(session, settings, deps);
			state.lastSyncAt = now();
		} finally {
			state.inFlight = false;
		}
	} catch (error) {
		logger.warn("[sessionContextSync] sync failed", { reason, error: String(error) });
	}
}

export const SessionContextSync = { maybeSync };
