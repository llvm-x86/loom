/**
 * Session context sync — keeps a per-repo status ledger (`<dir>/<slug>.md`)
 * up to date from the session transcript. Triggered on compaction, session
 * close, and prolonged idle (see `agent-session.ts` call sites). A total
 * no-op unless `sessionContextSync.enabled` and `sessionContextSync.dir`
 * are both configured — every failure is logged and swallowed, never thrown
 * to the caller, so this can never interrupt the interactive path.
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

async function slugForCwd(cwd: string, resolveRepo: (cwd: string) => Promise<string>): Promise<string> {
	try {
		const repo = await resolveRepo(cwd);
		if (repo) return repo.replaceAll("/", "-");
	} catch {
		// Fall through to the cwd-basename fallback below (not a git checkout,
		// no GitHub remote, `gh` unauthenticated, etc.) — never throws.
	}
	return path.basename(path.resolve(cwd)) || "session";
}

async function buildPrompt(ledgerPath: string, slug: string): Promise<string> {
	let existing: string | undefined;
	try {
		existing = await fs.readFile(ledgerPath, "utf8");
	} catch {
		existing = undefined;
	}
	const existingBlock = existing
		? `The ledger file already exists at ${ledgerPath}. Its current contents:\n\n${existing}`
		: `No ledger file exists yet at ${ledgerPath} — this session is creating it for the first time.`;
	return [
		`You are maintaining a persistent status ledger for the repo "${slug}" across coding-agent sessions.`,
		existingBlock,
		"",
		LEDGER_FORMAT_CONTRACT,
		"",
		"Using THIS SESSION's conversation so far, output ONLY the full updated ledger markdown, nothing else.",
		"Merge, don't append blindly; keep entries from other sessions.",
	].join("\n");
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

async function runSync(
	session: SessionContextSyncSession,
	settings: SessionContextSyncSettings,
	deps: SessionContextSyncDeps,
): Promise<void> {
	const resolveRepo = deps.resolveRepo ?? (cwd => resolveDefaultRepoMemoized(cwd));
	const slug = await slugForCwd(session.cwd, resolveRepo);
	const ledgerPath = path.join(expandTilde(settings.dir), `${slug}.md`);
	const promptText = await buildPrompt(ledgerPath, slug);
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
 * Sync the per-repo status ledger from this session's transcript. No-op
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
