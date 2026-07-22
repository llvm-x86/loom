/**
 * Loom WebBridge — wire protocol shared by the local daemon and the browser
 * extension.
 *
 * Mirrors Kimi WebBridge's ergonomics so the same agent workflow works against
 * the user's REAL browser (their live login sessions), driven locally:
 *
 *   agent  --HTTP-->  daemon  --WebSocket-->  extension  --CDP/DOM-->  browser
 *
 * The agent POSTs `{action, args, session}` to `POST /command` and gets back
 * `{ok:true, data}` or `{ok:false, error:{code,message}}`. The daemon is a thin
 * router: it forwards each command to the connected extension over a WebSocket
 * and correlates the reply by `id`. All browser/session/tab state lives in the
 * extension (it owns the `chrome.*` APIs); the daemon only post-processes
 * artifact-producing actions (screenshot) by writing bytes to disk.
 */

/** Loopback host the daemon binds. Never exposed off-box. */
export const WEBBRIDGE_HOST = "127.0.0.1";

/**
 * Default daemon port. Deliberately NOT Kimi's 10086 so a loom bridge and a
 * Kimi bridge can run side by side without clashing. Override with
 * `LOOM_WEBBRIDGE_PORT`.
 */
export const WEBBRIDGE_DEFAULT_PORT = 10088;

/** WebSocket upgrade path the extension dials. */
export const WEBBRIDGE_EXT_PATH = "/ext";

/** Resolve the effective port from the environment, falling back to the default. */
export function resolveWebBridgePort(): number {
	const raw = process.env.LOOM_WEBBRIDGE_PORT;
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0 && parsed < 65_536) return parsed;
	}
	return WEBBRIDGE_DEFAULT_PORT;
}

/** Actions the extension implements. `cdp` is a raw escape hatch. */
export const WEBBRIDGE_ACTIONS = [
	"navigate",
	"snapshot",
	"click",
	"fill",
	"evaluate",
	"screenshot",
	"list_tabs",
	"find_tab",
	"close_tab",
	"close_session",
	"cdp",
] as const;
export type WebBridgeAction = (typeof WEBBRIDGE_ACTIONS)[number];

/** Agent → daemon request body (`POST /command`). */
export interface CommandRequest {
	action: string;
	args?: Record<string, unknown>;
	/** Task name; collects the task's tabs into one tab group. Defaults to "default". */
	session?: string;
}

export interface CommandOk {
	ok: true;
	data: unknown;
}
export interface CommandError {
	ok: false;
	error: { code: string; message: string };
}
export type CommandResponse = CommandOk | CommandError;

/** Daemon → extension frame. */
export interface ExtCommandFrame {
	id: string;
	action: string;
	args: Record<string, unknown>;
	session: string;
}

/** Extension → daemon frames. */
export interface ExtReplyFrame {
	id: string;
	ok: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}
export interface ExtHelloFrame {
	type: "hello";
	version: string;
}
export type ExtInboundFrame = ExtReplyFrame | ExtHelloFrame;

/** Protocol version. The extension announces its own on connect; a mismatch is surfaced to the agent. */
export const WEBBRIDGE_PROTOCOL_VERSION = "1";
