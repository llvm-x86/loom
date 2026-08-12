/**
 * Hidden subcommand: `loom sync-context --resume <transcript> --reason shutdown [--activity-id <id>]`.
 *
 * Out-of-band worker entry point for agent-chat's shutdown-handoff spool
 * consumer (see the locked Context Activity contract). Loads the session
 * from its transcript, runs the context-sync exactly once (the `shutdown`
 * reason bypasses the debounce), emits start/done/fail/skip Context Activity
 * events (correlated by `--activity-id` when given), prints one final JSON
 * summary line to stdout, then exits.
 *
 * Sets `syncContextCliMode` on the session — a recursion guard so this
 * session's own dispose neither arms an idle context-sync timer nor writes
 * another shutdown spool (it already ran the sync itself, right here).
 *
 * Repair mode: `loom sync-context --repair <slug|all> [--dry-run]` is the
 * LLM-free ledger self-repair entry point (driven by agent-chat's repair
 * tick). It never loads a session: the ledger directory is resolved from
 * settings exactly the way the sync resolves it, each on-disk ledger is
 * validated/reordered by session-context-sync's `repairLedgerOnDisk`
 * (hazards-first block move ONLY — marker-class and missing-hazards ledgers
 * stay refused with their named reason), `repair` Context Activity events
 * are emitted per the frozen wire shape (session_id "ledger-repair"), one
 * final JSON summary line is printed, and the exit code is 0 when every
 * ledger was repaired or needed nothing, 1 on any refusal.
 */

import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { Settings } from "../config/settings";
import { createAgentSession } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { expandTilde } from "../tools/path-utils";
import {
	type ContextActivityEvent,
	type ContextActivityOutcome,
	type ContextActivityPhase,
	reportContextActivity,
} from "../utils/context-activity-reporter";
import {
	type LedgerRepairResult,
	maybeSync,
	repairLedgerOnDisk,
	type SessionContextSyncReason,
	type SessionContextSyncSession,
} from "../utils/session-context-sync";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { loadMnemopiConfig } from "../mnemopi/config";
import { loadMnemopi, loadMnemopiCore } from "../mnemopi/state";
import { renderMemoryTree } from "../mnemopi/tree";

interface SyncContextSummary {
	ok: boolean;
	repos: string[];
	tokens_in: number;
	tokens_out: number;
	outcome?: ContextActivityOutcome;
	refuse_reason?: string;
	error?: string;
}

const VALID_REASONS: readonly SessionContextSyncReason[] = ["compaction", "shutdown", "idle"];

/** Fixed session identity on every ledger-repair event (frozen wire shape). */
const REPAIR_SESSION_LABEL = "ledger-repair";

/** One skipped/refused ledger in the repair summary (frozen JSON wire shape). */
export interface LedgerRepairEntry {
	slug: string;
	reason: string;
}

/** Frozen JSON summary line printed by `--repair`; agent-chat's repair tick parses exactly this. */
export interface LedgerRepairSummary {
	ok: boolean;
	repaired: string[];
	skipped: LedgerRepairEntry[];
	refused: LedgerRepairEntry[];
}

export interface LedgerRepairDeps {
	/** Defaults to session-context-sync's `repairLedgerOnDisk`. */
	repairLedger?: (ledgerPath: string, opts: { dryRun: boolean }) => Promise<LedgerRepairResult>;
	/** Defaults to the fire-and-forget HTTP reporter at the configured `reportUrl`. */
	reportEvent?: (event: ContextActivityEvent) => void;
	/** Defaults to listing `<ledgerDir>/*.md`, skipping `_`-prefixed files (e.g. `_TEMPLATE.md`). */
	listSlugs?: (ledgerDir: string) => Promise<string[]>;
	/** Correlates every event of this run; defaults to a fresh uuid. */
	activityId?: string;
	now?: () => number;
}

async function listLedgerSlugs(ledgerDir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(ledgerDir);
	} catch {
		return []; // No ledger directory yet — nothing to repair.
	}
	return entries
		.filter(name => name.endsWith(".md") && !name.startsWith("_"))
		.map(name => name.slice(0, -".md".length))
		.sort();
}

/**
 * LLM-free on-disk ledger repair behind `--repair`. Validates and reorders
 * each target ledger via `repairLedgerOnDisk`, emits one `start` plus one
 * terminal (`done`/`skip`/`fail`) repair event per ledger per the frozen
 * wire shape, and returns the frozen summary. Classification of a
 * non-repaired result keys off the owned reason vocabulary: `"valid;"` /
 * `"dry-run:"` prefixes mean nothing-to-do (skip lane); every other reason
 * is a refusal (counts toward the exit-1 summary). Dry-run never writes and
 * reports every terminal event as `skip` with a `"dry-run: <verdict>"`
 * note, but classifies identically — a surveyed refusal is still a refusal.
 */
export async function repairLedgers(
	ledgerDir: string,
	target: string,
	dryRun: boolean,
	reportUrl: string,
	deps: LedgerRepairDeps = {},
): Promise<LedgerRepairSummary> {
	const repairLedger = deps.repairLedger ?? repairLedgerOnDisk;
	const reportEvent =
		deps.reportEvent ??
		(reportUrl ? (event: ContextActivityEvent) => reportContextActivity(event, reportUrl) : undefined);
	const listSlugs = deps.listSlugs ?? listLedgerSlugs;
	const now = deps.now ?? Date.now;
	const activityId = deps.activityId ?? Bun.randomUUIDv7();
	const summary: LedgerRepairSummary = { ok: true, repaired: [], skipped: [], refused: [] };
	const emit = (phase: ContextActivityPhase, slug: string, extra: Partial<ContextActivityEvent> = {}) => {
		reportEvent?.({
			id: activityId,
			kind: "repair",
			phase,
			session_id: REPAIR_SESSION_LABEL,
			session_label: REPAIR_SESSION_LABEL,
			trigger: "repair",
			repos: [slug],
			ts: now(),
			...extra,
		});
	};

	const slugs = target === "all" ? await listSlugs(ledgerDir) : [target];
	for (const slug of slugs) {
		const ledgerPath = path.join(ledgerDir, `${slug}.md`);
		emit("start", slug);
		if (!existsSync(ledgerPath)) {
			const reason = `ledger not found: ${ledgerPath}`;
			emit("skip", slug, { error: reason });
			summary.skipped.push({ slug, reason });
			continue;
		}
		let result: LedgerRepairResult;
		try {
			result = await repairLedger(ledgerPath, { dryRun });
		} catch (error) {
			// One ledger throwing must not strand its siblings (same rule as the
			// multi-repo sync); a throw means THIS ledger is unrepaired, so it
			// lands in the refused lane and fails the run.
			const reason = `repair threw — ${error instanceof Error ? error.message : String(error)}`;
			emit("fail", slug, { error: reason });
			summary.refused.push({ slug, reason });
			continue;
		}
		if (result.repaired) {
			emit("done", slug, { outcome: "persisted" });
			summary.repaired.push(slug);
			continue;
		}
		const reason = result.reason ?? "not repaired";
		if (dryRun) {
			// Frozen dry-run emission: always a skip carrying the computed verdict.
			emit("skip", slug, { error: reason.startsWith("dry-run:") ? reason : `dry-run: ${reason}` });
		} else if (reason.startsWith("valid;") || reason.startsWith("dry-run:")) {
			emit("skip", slug, { error: reason });
		} else {
			// A refusal completes without writing — mirror the sync path's
			// terminal `done` + explicit outcome so ingest can tell it apart
			// from a real repair.
			emit("done", slug, { outcome: "refused", refuse_reason: reason, error: `ledger not repaired — ${reason}` });
		}
		if (reason.startsWith("valid;") || reason.startsWith("dry-run:")) {
			summary.skipped.push({ slug, reason });
		} else {
			summary.refused.push({ slug, reason });
		}
	}
	summary.ok = summary.refused.length === 0;
	return summary;
}

/** Print the frozen summary line and exit once stdout has flushed (same idiom as the sync path below). */
function printRepairSummaryAndExit(summary: LedgerRepairSummary): void {
	const code = summary.ok ? 0 : 1;
	const bail = setTimeout(() => process.exit(code), 10_000);
	process.stdout.write(`${JSON.stringify(summary)}\n`, () => {
		clearTimeout(bail);
		process.exit(code);
	});
}

/** `--repair` entry: settings-only (no session), then the LLM-free repair pass. */
async function runRepairMode(target: string, dryRun: boolean, activityId: string | undefined): Promise<void> {
	const settings = await Settings.loadReadOnly();
	const syncSettings = settings.getGroup("sessionContextSync");
	if (!syncSettings.dir) {
		throw new CliUsageError(
			"sync-context --repair requires sessionContextSync.dir (the ledger directory) to be configured",
		);
	}
	const summary = await repairLedgers(expandTilde(syncSettings.dir), target, dryRun, syncSettings.reportUrl, {
		activityId,
	});
	printRepairSummaryAndExit(summary);
}

/**
 * Render every touched repo's memory tree from its mnemopi bank. The spool
 * repo slugs are GitHub `owner-repo` strings — identical to the repo-keyed
 * bank id (`mnemopi.bankRepo` / `LOOM_MNEMOPI_BANK_REPO`), so the bank name
 * IS the slug. Lanes that ran without a repo key used cwd-derived banks and
 * rendered in-process; here a missing bank file is simply skipped. Purely a
 * read of the bank plus file writes — never mutates the sqlite, never embeds.
 */
async function reconcileRepoMemoryTrees(settings: Settings, repos: readonly string[]): Promise<void> {
	const config = loadMnemopiConfig(settings, getAgentDir());
	if (!config.treeEnabled) return;
	const treeInput = {
		leafCharCap: config.treeLeafCharCap,
		entryRows: config.treeEntryRows,
		archiveGcDays: config.treeArchiveGcDays,
	};
	for (const repo of repos) {
		await reconcileRepoMemoryTree(config.treeRoot, path.dirname(config.dbPath), repo, treeInput).catch(
			(error: unknown) => {
				logger.warn("Sync-context: memory-tree render failed.", { repo, error: String(error) });
			},
		);
	}
}

/**
 * Render ONE repo's bank into its tree. Exported for tests; returns whether a
 * bank existed for the slug. Never throws on a missing bank — that is the
 * cwd-derived-bank case and simply skips.
 */
export async function reconcileRepoMemoryTree(
	treeRoot: string,
	dbDir: string,
	repo: string,
	opts: { leafCharCap?: number; entryRows?: number; archiveGcDays?: number } = {},
): Promise<boolean> {
	await loadMnemopi();
	const { BankManager, Mnemopi } = await loadMnemopiCore();
	const dbPath = new BankManager(dbDir).getBankDbPath(repo);
	if (!existsSync(dbPath)) return false;
	const memory = new Mnemopi({
		dbPath,
		bank: repo,
		sessionId: `sync-context-${repo}`,
		noEmbeddings: true,
	});
	try {
		// The tree filesystem is keyed per repo: each bank owns
		// `<treeRoot>/<repo>/MEMORY.md` + subtrees. Rendering into the raw
		// root would collide every repo's projection into one pile and leave
		// agents nothing at the documented `treeRoot/<repo>` location.
		await renderMemoryTree({
			memory,
			bank: repo,
			treeRoot: path.join(treeRoot, repo),
		});
		return true;
	} finally {
		memory.close();
	}
}

export default class SyncContext extends Command {
	static description = "Run a one-shot session-context sync out-of-band (used by agent-chat's shutdown worker)";
	static hidden = true;

	static flags = {
		resume: Flags.string({ description: "Transcript path to resume (not used with --repair)" }),
		reason: Flags.string({ description: "Sync reason recorded on the emitted events", default: "shutdown" }),
		"activity-id": Flags.string({
			description: "Activity id to correlate with an existing spool/job record",
		}),
		repair: Flags.string({
			description: "LLM-free on-disk ledger repair: a repo slug, or 'all' for every ledger in the directory",
		}),
		repos: Flags.string({
			description:
				"Comma-separated repo slugs to include in the close pass — from the shutdown " +
				"spool record, whose repos include env-keyed memory banks (LOOM_MNEMOPI_BANK_REPO) " +
				"that the resumed session's own git-based repo detection cannot see",
			default: "",
		}),
		"dry-run": Flags.boolean({
			description: "With --repair: compute and validate only; write nothing",
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(SyncContext);
		if (flags.repair !== undefined) {
			await runRepairMode(flags.repair, flags["dry-run"] === true, flags["activity-id"]);
			return;
		}
		// Spool-record repos (env-keyed banks like LOOM_MNEMOPI_BANK_REPO)
		// that a resumed session's own git-based repo detection cannot see.
		// Merged with `event.repos` in the close pass so every bank the
		// closed session touched gets its tree rendered.
		const spoolRepos = (flags.repos ?? "")
			.split(",")
			.map(repo => repo.trim())
			.filter(Boolean);

		const reason: SessionContextSyncReason = (VALID_REASONS as readonly string[]).includes(flags.reason ?? "")
			? (flags.reason as SessionContextSyncReason)
			: "shutdown";

		const summary: SyncContextSummary = { ok: false, repos: [], tokens_in: 0, tokens_out: 0 };
		let dispose: (() => Promise<void>) | undefined;
		try {
			if (!flags.resume) {
				// Tree-only close pass: a lane killed by a signal or fatal
				// error may never have persisted its transcript, so the
				// ledger resume is impossible — but the spool record's repos
				// still name the banks whose trees must be rendered. Runs
				// the same LLM-free projection, then falls through to the
				// shared summary/exit tail.
				if (spoolRepos.length === 0) {
					throw new CliUsageError("sync-context requires --resume <transcript> or --repos <repo[,repo...]>");
				}
				const settings = await Settings.loadReadOnly();
				await reconcileRepoMemoryTrees(settings, spoolRepos).catch((error: unknown) => {
					logger.warn("Sync-context: memory-tree reconcile failed.", { error: String(error) });
				});
				summary.ok = true;
				summary.repos = spoolRepos.slice();
				return;
			}
			if (!existsSync(flags.resume)) {
				throw new CliUsageError(
					`sync-context --resume transcript not found: ${flags.resume} (a nonexistent path would silently start a fresh session)`,
				);
			}
			const sessionManager = await SessionManager.open(flags.resume);
			const { session } = await createAgentSession({
				cwd: sessionManager.getCwd(),
				sessionManager,
				disableExtensionDiscovery: true,
				syncContextCliMode: true,
			});
			dispose = () => session.dispose();

			const handle: SessionContextSyncSession = {
				cwd: sessionManager.getCwd(),
				sessionId: session.sessionId,
				sessionLabel: session.sessionName,
				transcriptPath: sessionManager.getSessionFile(),
				settings: session.settings,
				messages: session.messages,
				runEphemeralTurn: args => session.runEphemeralTurn(args),
			};
			const reportUrl = session.settings.getGroup("sessionContextSync").reportUrl;

			let failure: string | undefined;
			await maybeSync(handle, reason, {
				activityId: flags["activity-id"],
				reportEvent: event => {
					reportContextActivity(event, reportUrl);
					if (event.phase === "done") {
						summary.repos = event.repos ?? [];
						summary.tokens_in = event.tokens_in ?? 0;
						summary.tokens_out = event.tokens_out ?? 0;
						summary.outcome = event.outcome;
						// A refused write is a completed sync that persisted nothing:
						// the activity event stays `done` (with `outcome: "refused"`),
						// but the worker's exit code must still say failure.
						if (event.outcome === "refused") {
							summary.refuse_reason = event.refuse_reason;
							failure = event.refuse_reason ?? event.error;
						}
					} else if (event.phase === "fail" || event.phase === "skip") {
						failure = event.error;
						summary.repos = event.repos ?? summary.repos;
					}
				},
			});
			for (const repo of spoolRepos) {
				if (!summary.repos.includes(repo)) summary.repos.push(repo);
			}

			// Storage handoff: this CLI run IS the service worker's session-close
			// pass, so render every touched repo's memory tree (an LLM-free
			// projection of the bank) here — lanes killed before `dispose` never
			// got an in-process render, and the service owns storage. Best-effort:
			// a failed render never changes the ledger outcome or the exit code
			// (the tree is disposable and the next pass repairs it).
			if (!failure && summary.repos.length > 0) {
				await reconcileRepoMemoryTrees(session.settings, summary.repos).catch((error: unknown) => {
					logger.warn("Sync-context: memory-tree reconcile failed.", { error: String(error) });
				});
			}

			summary.ok = failure === undefined;
			if (failure) summary.error = failure;
		} catch (error) {
			summary.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (dispose) await dispose().catch(() => undefined);
			// This is a one-shot worker: createAgentSession leaves handles the
			// dispose path does not release (providers, timers, singletons),
			// and a single live handle keeps the event loop — and the entire
			// loaded session — resident after the sync finished. That was the
			// 5.3GB-per-shutdown leak: every sync-context process lingered
			// until agent-chat's timeout SIGKILL (or forever behind sudo).
			// Exit explicitly once stdout has flushed; the timer is a bounded
			// fallback in case the write callback never fires (EPIPE).
			const code = summary.ok ? 0 : 1;
			const bail = setTimeout(() => process.exit(code), 10_000);
			process.stdout.write(`${JSON.stringify(summary)}\n`, () => {
				clearTimeout(bail);
				process.exit(code);
			});
		}
	}
}
