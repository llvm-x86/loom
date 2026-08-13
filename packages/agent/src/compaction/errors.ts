/**
 * Compaction error types.
 *
 * `CompactionCancelledError` is the canonical signal raised when a compaction
 * is explicitly aborted — operator Esc, extension hook returning `cancel`,
 * programmatic `session.abortCompaction()` call, or any other deliberate
 * abort source. Downstream callers (e.g. `executeCompaction`) discriminate
 * cancellation from other failures via `instanceof CompactionCancelledError`
 * rather than introspecting error messages or `name` fields — the typed
 * sentinel makes classification source-agnostic and refactor-stable.
 */

export class CompactionCancelledError extends Error {
	readonly name = "CompactionCancelledError" as const;

	constructor(message = "Compaction cancelled") {
		super(message);
	}
}

/**
 * Raised when compaction has no usable credential to run with — every
 * candidate model was unauthenticated, or the only ones that answered
 * rejected the credential (401/403).
 *
 * This is the one compaction failure that must stay loud. Capacity failures
 * (an exhausted 5h usage window, a quota cap, a context overflow) are the
 * provider saying "not now", and the session recovers by archiving history
 * locally with snapcompact. A credential failure is the *operator* saying
 * nothing at all works: the same broken auth blocks every ordinary turn, so
 * silently archiving would hide the one fact the user has to act on. Callers
 * discriminate via `instanceof` rather than message matching — see issue #986,
 * which is exactly the regression of swallowing this as a generic failure.
 */
export class CompactionCredentialsError extends Error {
	readonly name = "CompactionCredentialsError" as const;
}

/**
 * Outcome of a compaction attempt, surfaced by `CommandController.executeCompaction`
 * so callers (e.g. the plan-mode approval flow) can distinguish a deliberate abort
 * from an unrelated failure.
 *
 *   "ok"        — compaction completed; transcript was summarized.
 *   "cancelled" — `CompactionCancelledError` was raised. Operator Esc, extension
 *                 hook, programmatic abort — all source-agnostic.
 *   "failed"    — any other rejection from `session.compact()`.
 */
export type CompactionOutcome = "ok" | "cancelled" | "failed";
