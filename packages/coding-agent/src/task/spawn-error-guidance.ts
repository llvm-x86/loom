/**
 * Actionable guidance appended to a failed spawn's parent-facing result text
 * when the failure is a provider quota/rate-limit block.
 *
 * Context: when a provider credential is quota-parked (pi-ai's
 * `markUsageLimitReached`), every subsequent spawn against that provider
 * instant-fails (~300ms) until the block expires. Left alone, the parent
 * agent tends to retry-loop against the same parked credential, burning
 * context and — because retries themselves can count against the block —
 * potentially extending the ban. This module reuses the same rate-limit
 * classification signal the task renderer already uses for its
 * `⟦rate-limited⟧` chip (`SingleResult.retryFailure`, set from
 * `AgentProgress.retryFailure` — see render.ts / executor.ts), falling back
 * to a text match when that structured signal isn't present (e.g. the
 * failure surfaced from `stderr` rather than the retry loop).
 */
import type { SingleResult } from "./types";

/** Mirrors the provider-side classification pi-ai uses for quota/rate-limit errors. */
const RATE_LIMIT_TEXT_PATTERN = /resource_exhausted|usage.?limit|rate.?limit|insufficient_quota|429/i;

/** Marker substring used both to compose and to detect an already-appended guidance block. */
const GUIDANCE_MARKER = "Do NOT retry the same model";

type ClassifiableResult = Pick<SingleResult, "retryFailure" | "error" | "stderr" | "resolvedModel" | "agent">;

/**
 * True when a failed spawn's error should be treated as a provider
 * quota/rate-limit block rather than an ordinary failure.
 */
export function isRateLimitFailure(result: ClassifiableResult): boolean {
	if (result.retryFailure) return true;
	return RATE_LIMIT_TEXT_PATTERN.test(`${result.error ?? ""} ${result.stderr ?? ""}`);
}

/** Build the one-shot guidance block for a rate-limit-classified failure. */
function buildGuidance(result: ClassifiableResult): string {
	const target = result.resolvedModel || result.agent || "the provider";
	return (
		`Provider quota exhausted for ${target}. ${GUIDANCE_MARKER} — the credential is parked and ` +
		`instant-fails until the block expires; blind retries waste context and can extend the ban. ` +
		`Options: (1) pin a DIFFERENT provider's model on each tasks[] item (e.g. "model": ` +
		`["kimi-code/k3", "anthropic/claude-haiku-4-5"]), (2) run the work inline yourself, or ` +
		`(3) wait for the quota window to reset before respawning.`
	);
}

/**
 * Append quota-block guidance to `text` when `result` is a rate-limit-classified
 * failure. No-op for ordinary failures/successes and idempotent — safe to call
 * on text that already carries the guidance block (e.g. if the same result is
 * rendered twice) without duplicating it.
 */
export function appendSpawnErrorGuidance(text: string, result: ClassifiableResult): string {
	if (!isRateLimitFailure(result)) return text;
	if (text.includes(GUIDANCE_MARKER)) return text;
	return `${text}\n\n${buildGuidance(result)}`;
}
