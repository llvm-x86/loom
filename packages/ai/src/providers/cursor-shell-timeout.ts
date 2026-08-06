import type { ShellArgs } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

/** Loom bash tool max timeout in seconds (`TOOL_TIMEOUTS.bash.max`). */
export const BASH_MAX_TIMEOUT_SEC = 3600;

/**
 * Normalize a shell timeout for Loom's bash tool (seconds).
 *
 * Agents and Cursor often send millisecond values (e.g. 15000 for 15s) —
 * the same scale as `block_until_ms`. Values above the bash ceiling are
 * treated as milliseconds; values at or below it are treated as seconds.
 */
export function normalizeShellTimeoutSeconds(raw: number | undefined): number | undefined {
	if (raw === undefined || raw <= 0) return undefined;
	if (raw > BASH_MAX_TIMEOUT_SEC) {
		return Math.max(1, Math.ceil(raw / 1000));
	}
	return raw;
}

/**
 * Normalize Cursor exec shell timeouts for Loom's bash tool (seconds).
 *
 * Cursor's `hard_timeout` is always milliseconds and takes precedence.
 */
export function resolveCursorShellTimeoutSeconds(
	args: Pick<ShellArgs, "timeout" | "hardTimeout">,
): number | undefined {
	const hardMs = args.hardTimeout && args.hardTimeout > 0 ? args.hardTimeout : undefined;
	if (hardMs !== undefined) {
		return Math.max(1, Math.ceil(hardMs / 1000));
	}
	return normalizeShellTimeoutSeconds(args.timeout && args.timeout > 0 ? args.timeout : undefined);
}
