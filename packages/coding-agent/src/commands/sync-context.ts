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
 */
import { CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { createAgentSession } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { reportContextActivity } from "../utils/context-activity-reporter";
import {
	maybeSync,
	type SessionContextSyncReason,
	type SessionContextSyncSession,
} from "../utils/session-context-sync";

interface SyncContextSummary {
	ok: boolean;
	repos: string[];
	tokens_in: number;
	tokens_out: number;
	error?: string;
}

const VALID_REASONS: readonly SessionContextSyncReason[] = ["compaction", "shutdown", "idle"];

export default class SyncContext extends Command {
	static description = "Run a one-shot session-context sync out-of-band (used by agent-chat's shutdown worker)";
	static hidden = true;

	static flags = {
		resume: Flags.string({ description: "Transcript path to resume", required: true }),
		reason: Flags.string({ description: "Sync reason recorded on the emitted events", default: "shutdown" }),
		"activity-id": Flags.string({
			description: "Activity id to correlate with an existing spool/job record",
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(SyncContext);
		if (!flags.resume) throw new CliUsageError("sync-context requires --resume <transcript>");
		const reason: SessionContextSyncReason = (VALID_REASONS as readonly string[]).includes(flags.reason ?? "")
			? (flags.reason as SessionContextSyncReason)
			: "shutdown";

		const summary: SyncContextSummary = { ok: false, repos: [], tokens_in: 0, tokens_out: 0 };
		let dispose: (() => Promise<void>) | undefined;
		try {
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
					} else if (event.phase === "fail" || event.phase === "skip") {
						failure = event.error;
						summary.repos = event.repos ?? summary.repos;
					}
				},
			});

			summary.ok = failure === undefined;
			if (failure) summary.error = failure;
		} catch (error) {
			summary.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (dispose) await dispose().catch(() => undefined);
			process.stdout.write(`${JSON.stringify(summary)}\n`);
		}
		if (!summary.ok) process.exitCode = 1;
	}
}
