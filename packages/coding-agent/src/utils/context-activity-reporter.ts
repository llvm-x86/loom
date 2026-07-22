/**
 * Context Activity reporter — fire-and-forget event push to agent-chat's
 * local event-ingest endpoint (`POST <reportUrl>/api/context/event`).
 *
 * Part of the Context Activity system: live observability of background
 * compactions + context-syncs, running alongside the shutdown spool handoff
 * and the pause/throttle control file (see `session-context-sync.ts`,
 * `agent-session.ts` dispose, and the locked cross-repo build contract).
 *
 * `reportContextActivity` is NEVER awaited by callers: it fires the request
 * and returns immediately. All errors (agent-chat down, unreachable,
 * timed out) are swallowed — a reporting failure must never affect loom's
 * control flow.
 */
import { withTimeoutSignal } from "./fetch-timeout";

export type ContextActivityKind = "sync" | "compaction";
export type ContextActivityPhase = "start" | "done" | "skip" | "fail";
/** Matches `SessionContextSyncReason`; compaction events always report "compaction". */
export type ContextActivityTrigger = "compaction" | "idle" | "shutdown";

/** Wire shape POSTed to `/api/context/event` — see the locked contract for field semantics. */
export interface ContextActivityEvent {
	/** Stable per sync/compaction attempt; loom generates one, or the caller passes one (e.g. `--activity-id`). */
	id: string;
	kind: ContextActivityKind;
	phase: ContextActivityPhase;
	session_id: string;
	session_label?: string;
	transcript_path?: string;
	trigger: ContextActivityTrigger;
	repos?: string[];
	tokens_in?: number;
	tokens_out?: number;
	cache_read?: number;
	model?: string;
	provider?: string;
	duration_ms?: number;
	ts: number;
	/** Also doubles as the human-readable skip reason on `phase: "skip"` (disabled/empty/inflight/debounce/paused). */
	error?: string;
}

const EVENT_PATH = "/api/context/event";
/** Best-effort ceiling; never worth blocking or retrying past this. */
const REPORT_TIMEOUT_MS = 300;

/**
 * Fire-and-forget POST of a Context Activity event. Never throws and is
 * never awaited by the caller — an empty `reportUrl` (reporting disabled,
 * the default off state for tests/CLI probes) is a synchronous no-op.
 */
export function reportContextActivity(event: ContextActivityEvent, reportUrl: string): void {
	if (!reportUrl) return;
	void fetch(`${reportUrl}${EVENT_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(event),
		signal: withTimeoutSignal(REPORT_TIMEOUT_MS),
	}).catch(() => undefined);
}
