import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { ensureBrowserOpen } from "@oh-my-pi/pi-coding-agent/webbridge/control";
import { WebBridgeDaemon } from "@oh-my-pi/pi-coding-agent/webbridge/daemon";

/**
 * Exercises the daemon's routing contract with a SIMULATED extension (a plain
 * WebSocket client standing in for the real browser extension). Proves:
 * command forwarding + id correlation, screenshot base64 -> file, the
 * extension-not-connected error, and the reply timeout — without a browser.
 */
describe("WebBridge daemon", () => {
	let daemon: WebBridgeDaemon;

	beforeEach(() => {
		daemon = new WebBridgeDaemon({ port: 0, timeoutMs: 200 });
		daemon.start();
	});

	afterEach(async () => {
		await daemon.stop();
	});

	/** Connect a fake extension that answers commands via `handler` (returning undefined = never reply). */
	async function connectExtension(
		handler: (frame: { id: string; action: string; args: Record<string, unknown>; session: string }) => unknown,
	): Promise<WebSocket> {
		const ws = new WebSocket(`ws://127.0.0.1:${daemon.listenPort}/ext`);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("ext socket error")), { once: true });
		});
		ws.send(JSON.stringify({ type: "hello", version: "1" }));
		ws.addEventListener("message", event => {
			const frame = JSON.parse(String(event.data)) as {
				id: string;
				action: string;
				args: Record<string, unknown>;
				session: string;
			};
			const data = handler(frame);
			if (data === undefined) return; // simulate a non-responding extension
			ws.send(JSON.stringify({ id: frame.id, ok: true, data }));
		});
		await daemon.waitForExtension();
		return ws;
	}

	async function postCommand(body: unknown): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> {
		const res = await fetch(`http://127.0.0.1:${daemon.listenPort}/command`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return (await res.json()) as { ok: boolean; data?: unknown; error?: { code: string } };
	}

	it("reports health with extension connectivity", async () => {
		const before = await (await fetch(`http://127.0.0.1:${daemon.listenPort}/health`)).json();
		expect(before).toMatchObject({ ok: true, service: "loom-webbridge", extensionConnected: false });
		const ws = await connectExtension(() => ({ success: true }));
		const after = await (await fetch(`http://127.0.0.1:${daemon.listenPort}/health`)).json();
		expect(after).toMatchObject({ ok: true, extensionConnected: true, extensionVersion: "1" });
		ws.close();
	});

	it("forwards a command to the extension and returns its data", async () => {
		const seen: Array<{ action: string; args: Record<string, unknown>; session: string }> = [];
		const ws = await connectExtension(frame => {
			seen.push({ action: frame.action, args: frame.args, session: frame.session });
			return { success: true, tag: "BUTTON", text: "Wireless" };
		});
		const result = await postCommand({ action: "click", args: { selector: "@e12" }, session: "wifi-setup" });
		expect(result).toEqual({ ok: true, data: { success: true, tag: "BUTTON", text: "Wireless" } });
		expect(seen).toEqual([{ action: "click", args: { selector: "@e12" }, session: "wifi-setup" }]);
		ws.close();
	});

	it("defaults a missing session to 'default'", async () => {
		let observedSession = "";
		const ws = await connectExtension(frame => {
			observedSession = frame.session;
			return { success: true };
		});
		await postCommand({ action: "snapshot", args: {} });
		expect(observedSession).toBe("default");
		ws.close();
	});

	it("multiplexes concurrent sessions — out-of-order replies stay id-correlated", async () => {
		// The invariant that lets many loom sessions drive one browser at once:
		// two sessions dispatched concurrently, answered in REVERSE order, must
		// each resolve with their OWN reply — never cross-wired.
		const frames: Array<{ id: string; session: string }> = [];
		const ws = await connectExtension(frame => {
			frames.push({ id: frame.id, session: frame.session });
			return undefined; // reply manually below, deliberately out of order
		});
		const pAlpha = postCommand({ action: "snapshot", args: {}, session: "alpha" });
		const pBeta = postCommand({ action: "snapshot", args: {}, session: "beta" });
		while (frames.length < 2) await Bun.sleep(5);
		for (const frame of [...frames].reverse()) {
			ws.send(JSON.stringify({ id: frame.id, ok: true, data: { echoSession: frame.session } }));
		}
		const [alpha, beta] = await Promise.all([pAlpha, pBeta]);
		expect(alpha).toEqual({ ok: true, data: { echoSession: "alpha" } });
		expect(beta).toEqual({ ok: true, data: { echoSession: "beta" } });
		expect(new Set(frames.map(f => f.session))).toEqual(new Set(["alpha", "beta"]));
		ws.close();
	});

	it("writes a screenshot's base64 payload to disk and returns a path", async () => {
		// 1x1 transparent PNG.
		const pngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		const ws = await connectExtension(() => ({ format: "png", base64: pngBase64 }));
		const result = await postCommand({ action: "screenshot", args: {}, session: "s" });
		expect(result.ok).toBe(true);
		const data = result.data as { path: string; sizeBytes: number; mimeType: string; format: string };
		expect(data.mimeType).toBe("image/png");
		expect(data.sizeBytes).toBeGreaterThan(0);
		const bytes = await fs.readFile(data.path);
		expect(bytes.byteLength).toBe(data.sizeBytes);
		await fs.rm(data.path, { force: true });
		ws.close();
	});

	it("errors when no extension is connected", async () => {
		const result = await postCommand({ action: "snapshot", args: {}, session: "s" });
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("extension_not_connected");
	});

	it("times out when the extension never replies", async () => {
		// Integration check of the daemon's real reply-timeout path (200ms override);
		// deterministic fake timers cannot drive the daemon's internal setTimeout here.
		const ws = await connectExtension(() => undefined);
		const result = await postCommand({ action: "evaluate", args: { code: "1" }, session: "s" });
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("timeout");
		ws.close();
	});

	it("rejects a command with no action", async () => {
		const ws = await connectExtension(() => ({ success: true }));
		const result = await postCommand({ args: {}, session: "s" });
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("bad_request");
		ws.close();
	});

	it("ensureBrowserOpen focuses the window when a browser is already connected", async () => {
		const seen: string[] = [];
		const ws = await connectExtension(frame => {
			seen.push(frame.action);
			return { focused: true, created: false };
		});
		const result = await ensureBrowserOpen(daemon.listenPort);
		expect(result).toMatchObject({ connected: true, launched: false, focused: true });
		expect(seen).toContain("focus");
		ws.close();
	});
});
