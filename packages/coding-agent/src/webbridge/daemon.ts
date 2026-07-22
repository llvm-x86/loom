/**
 * Loom WebBridge daemon.
 *
 * A loopback HTTP + WebSocket server. Agents POST `{action,args,session}` to
 * `POST /command`; the daemon forwards the command to the connected browser
 * extension over a WebSocket, correlates the reply by id, and returns
 * `{ok,data}`. See {@link file://./protocol.ts} for the wire contract.
 *
 * The daemon is intentionally thin: it owns no browser/session/tab state (the
 * extension does). Its only content-aware step is turning artifact-producing
 * actions (`screenshot`) into files on disk, since the model reads a path, not
 * raw base64.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Server, ServerWebSocket } from "bun";
import {
	type CommandRequest,
	type CommandResponse,
	type ExtInboundFrame,
	type ExtReplyFrame,
	resolveWebBridgePort,
	WEBBRIDGE_EXT_PATH,
	WEBBRIDGE_HOST,
	WEBBRIDGE_PROTOCOL_VERSION,
} from "./protocol";

/** Per-action wall-clock ceilings (ms). Navigation and PDF rendering get longer. */
const ACTION_TIMEOUT_MS: Record<string, number> = {
	navigate: 45_000,
	screenshot: 30_000,
	save_as_pdf: 60_000,
	evaluate: 30_000,
};
const DEFAULT_TIMEOUT_MS = 30_000;

interface PendingRequest {
	resolve: (frame: ExtReplyFrame) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ExtSocketData {
	extId: string;
}

export interface WebBridgeDaemonOptions {
	port?: number;
	host?: string;
	/** Test hook: override every action's reply timeout. */
	timeoutMs?: number;
}

export class WebBridgeDaemon {
	readonly #port: number;
	readonly #host: string;
	#server: Server<ExtSocketData> | undefined;
	/** The active extension socket (most recent wins). */
	#ext: ServerWebSocket<ExtSocketData> | undefined;
	#extVersion: string | undefined;
	readonly #timeoutOverride: number | undefined;
	readonly #pending = new Map<string, PendingRequest>();
	#extWaiters: Array<() => void> = [];

	constructor(options: WebBridgeDaemonOptions = {}) {
		this.#port = options.port ?? resolveWebBridgePort();
		this.#host = options.host ?? WEBBRIDGE_HOST;
		this.#timeoutOverride = options.timeoutMs;
	}

	get port(): number {
		return this.#port;
	}

	/** Actual bound port (resolves an ephemeral `port: 0` to the OS-assigned port). */
	get listenPort(): number {
		return this.#server?.port ?? this.#port;
	}

	get extensionConnected(): boolean {
		return this.#ext !== undefined;
	}

	/**
	 * Resolve once a browser extension is connected (immediately if one already
	 * is). Rejects after `timeoutMs`. Lets callers (and tests) await a live
	 * browser without polling.
	 */
	waitForExtension(timeoutMs = 5_000): Promise<void> {
		if (this.#ext) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#extWaiters = this.#extWaiters.filter(waiter => waiter !== onConnect);
				reject(new Error("no browser extension connected"));
			}, timeoutMs);
			const onConnect = (): void => {
				clearTimeout(timer);
				resolve();
			};
			this.#extWaiters.push(onConnect);
		});
	}

	start(): void {
		if (this.#server) return;
		const daemon = this;
		this.#server = Bun.serve<ExtSocketData>({
			hostname: this.#host,
			port: this.#port,
			async fetch(req, server) {
				const url = new URL(req.url);
				if (url.pathname === WEBBRIDGE_EXT_PATH) {
					if (server.upgrade(req, { data: { extId: randomUUID() } })) return undefined;
					return new Response("expected websocket upgrade", { status: 426 });
				}
				if (url.pathname === "/health" && req.method === "GET") {
					return Response.json({
						ok: true,
						service: "loom-webbridge",
						version: WEBBRIDGE_PROTOCOL_VERSION,
						extensionConnected: daemon.extensionConnected,
						extensionVersion: daemon.#extVersion,
					});
				}
				if (url.pathname === "/command" && req.method === "POST") {
					let body: CommandRequest;
					try {
						body = (await req.json()) as CommandRequest;
					} catch {
						return Response.json(
							{ ok: false, error: { code: "bad_request", message: "body must be JSON" } },
							{ status: 400 },
						);
					}
					const result = await daemon.dispatch(body);
					return Response.json(result);
				}
				return new Response("not found", { status: 404 });
			},
			websocket: {
				open(ws) {
					daemon.#ext = ws;
					logger.debug("webbridge: extension connected", { extId: ws.data.extId });
					for (const waiter of daemon.#extWaiters.splice(0)) waiter();
				},
				message(ws, message) {
					daemon.#onExtMessage(ws, message);
				},
				close(ws) {
					if (daemon.#ext === ws) {
						daemon.#ext = undefined;
						daemon.#extVersion = undefined;
						daemon.#failAllPending("extension_disconnected", "browser extension disconnected");
					}
				},
			},
		});
		logger.info(`webbridge daemon listening on http://${this.#host}:${this.#port}`);
	}

	async stop(): Promise<void> {
		this.#failAllPending("daemon_stopped", "webbridge daemon stopping");
		this.#server?.stop(true);
		this.#server = undefined;
		this.#ext = undefined;
	}

	/** Route one agent command to the extension and shape the response. */
	async dispatch(request: CommandRequest): Promise<CommandResponse> {
		const action = typeof request.action === "string" ? request.action.trim() : "";
		if (!action) {
			return { ok: false, error: { code: "bad_request", message: "missing action" } };
		}
		if (!this.#ext) {
			return {
				ok: false,
				error: {
					code: "extension_not_connected",
					message: "no browser extension connected — load the Loom WebBridge extension and ensure it is enabled",
				},
			};
		}
		const session =
			typeof request.session === "string" && request.session.trim() ? request.session.trim() : "default";
		const args = (request.args ?? {}) as Record<string, unknown>;
		const id = randomUUID();
		const timeoutMs = this.#timeoutOverride ?? ACTION_TIMEOUT_MS[action] ?? DEFAULT_TIMEOUT_MS;

		const reply = await this.#sendAndWait(id, { id, action, args, session }, timeoutMs);
		if (!reply.ok) {
			return { ok: false, error: reply.error ?? { code: "extension_error", message: "extension returned no data" } };
		}
		try {
			const data = await this.#postProcess(action, args, reply.data);
			return { ok: true, data };
		} catch (error) {
			return {
				ok: false,
				error: { code: "daemon_error", message: error instanceof Error ? error.message : String(error) },
			};
		}
	}

	#sendAndWait(id: string, frame: unknown, timeoutMs: number): Promise<ExtReplyFrame> {
		return new Promise<ExtReplyFrame>(resolve => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				resolve({
					id,
					ok: false,
					error: { code: "timeout", message: `extension did not reply within ${timeoutMs}ms` },
				});
			}, timeoutMs);
			this.#pending.set(id, { resolve, timer });
			try {
				this.#ext?.send(JSON.stringify(frame));
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				resolve({
					id,
					ok: false,
					error: { code: "send_failed", message: error instanceof Error ? error.message : String(error) },
				});
			}
		});
	}

	#onExtMessage(_ws: ServerWebSocket<ExtSocketData>, message: string | Buffer): void {
		let frame: ExtInboundFrame;
		try {
			frame = JSON.parse(typeof message === "string" ? message : message.toString("utf8")) as ExtInboundFrame;
		} catch {
			logger.warn("webbridge: dropping non-JSON frame from extension");
			return;
		}
		if ("type" in frame && frame.type === "hello") {
			this.#extVersion = frame.version;
			logger.debug("webbridge: extension hello", { version: frame.version });
			return;
		}
		const reply = frame as ExtReplyFrame;
		if (!reply.id) return;
		const pending = this.#pending.get(reply.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.#pending.delete(reply.id);
		pending.resolve(reply);
	}

	#failAllPending(code: string, message: string): void {
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.resolve({ id, ok: false, error: { code, message } });
		}
		this.#pending.clear();
	}

	/**
	 * Turn artifact-producing action results into files on disk. `screenshot`
	 * comes back as base64 from the extension (a service worker cannot touch the
	 * filesystem); the daemon writes the bytes and returns a path the model can
	 * `read`.
	 */
	async #postProcess(action: string, args: Record<string, unknown>, data: unknown): Promise<unknown> {
		if (action !== "screenshot") return data;
		if (!data || typeof data !== "object") return data;
		const record = data as Record<string, unknown>;
		const base64 = typeof record.base64 === "string" ? record.base64 : undefined;
		if (!base64) return data;
		const format = typeof record.format === "string" ? record.format : "png";
		const requestedPath = typeof args.path === "string" ? args.path : undefined;
		const outPath =
			requestedPath ?? path.join(os.tmpdir(), `loom-webbridge-${Date.now()}-${randomUUID().slice(0, 8)}.${format}`);
		await fs.mkdir(path.dirname(outPath), { recursive: true });
		const bytes = Buffer.from(base64, "base64");
		await fs.writeFile(outPath, bytes);
		return {
			format,
			path: outPath,
			sizeBytes: bytes.byteLength,
			mimeType: format === "jpeg" || format === "jpg" ? "image/jpeg" : "image/png",
		};
	}
}

/** Probe whether a daemon is already answering on `port`. */
export async function isDaemonRunning(port: number, host = WEBBRIDGE_HOST): Promise<boolean> {
	try {
		const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1_500) });
		return res.ok;
	} catch {
		return false;
	}
}
