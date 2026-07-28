/**
 * The browser tool must not silently launch a hidden headless Chromium when
 * the user's REAL browser is reachable through the loom WebBridge.
 *
 * Everything here is dependency-injected: the detector is passed to
 * `BrowserTool`, and `detectConnectedWebBridge`'s own cache tests use a fake
 * `fetch` + clock. Nothing touches the network or spawns a browser —
 * `acquireBrowser` is spied and throws a sentinel, so reaching the launch path
 * is observable without paying for it.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { BrowserTool } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as registry from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	detectConnectedWebBridge,
	resetWebBridgeDetectionCache,
} from "@oh-my-pi/pi-coding-agent/tools/browser/webbridge-detect";

const LAUNCH_SENTINEL = "acquireBrowser-reached";

function makeSession(): ToolSession {
	const settings = Settings.isolated();
	settings.set("browser.cmux", false);
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

/** Spy that fails loudly if the tool ever tries to acquire a browser handle. */
function stubAcquireBrowser() {
	return spyOn(registry, "acquireBrowser").mockImplementation(async () => {
		throw new Error(LAUNCH_SENTINEL);
	});
}

describe("browser open — WebBridge routing", () => {
	afterEach(() => {
		resetWebBridgeDetectionCache();
	});

	it("refuses headless and steers to the WebBridge when the extension is connected", async () => {
		const acquire = stubAcquireBrowser();
		try {
			const tool = new BrowserTool(makeSession(), {
				detectWebBridge: async () => ({ port: 10088 }),
			});
			const promise = tool.execute("call-webbridge", { action: "open", url: "https://example.com" });
			await expect(promise).rejects.toThrow(/loom WebBridge on 127\.0\.0\.1:10088/);
			await promise.catch((error: Error) => {
				expect(error.message).toContain("skill://loom-webbridge");
				expect(error.message).toContain("http://127.0.0.1:10088/command");
			});
			expect(acquire).not.toHaveBeenCalled();
		} finally {
			acquire.mockRestore();
		}
	});

	it("falls through to the headless launch path when no bridge is detected", async () => {
		const acquire = stubAcquireBrowser();
		try {
			const tool = new BrowserTool(makeSession(), { detectWebBridge: async () => undefined });
			await expect(tool.execute("call-headless", { action: "open" })).rejects.toThrow(LAUNCH_SENTINEL);
			expect(acquire).toHaveBeenCalledTimes(1);
			expect(acquire.mock.calls[0]?.[0]).toMatchObject({ kind: "headless" });
		} finally {
			acquire.mockRestore();
		}
	});

	it("never consults the probe when an explicit app is supplied", async () => {
		const acquire = stubAcquireBrowser();
		let probed = 0;
		try {
			const tool = new BrowserTool(makeSession(), {
				detectWebBridge: async () => {
					probed++;
					return { port: 10088 };
				},
			});

			await expect(
				tool.execute("call-cdp", { action: "open", app: { cdp_url: "http://127.0.0.1:9222" } }),
			).rejects.toThrow(LAUNCH_SENTINEL);
			await expect(
				tool.execute("call-spawn", { action: "open", name: "app", app: { path: "/usr/bin/chromium" } }),
			).rejects.toThrow(LAUNCH_SENTINEL);

			expect(probed).toBe(0);
			expect(acquire.mock.calls.map(call => call[0].kind)).toEqual(["connected", "spawned"]);
		} finally {
			acquire.mockRestore();
		}
	});
});

describe("detectConnectedWebBridge caching", () => {
	afterEach(() => {
		resetWebBridgeDetectionCache();
	});

	it("returns the port only when the daemon reports a connected extension", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return Response.json({ ok: true, extensionConnected: true });
		}) as unknown as typeof globalThis.fetch;

		expect(await detectConnectedWebBridge({ fetch: fetchImpl, now: () => 0, port: 4242 })).toEqual({ port: 4242 });
		expect(calls).toBeGreaterThan(0);

		// Positive results are cached for the process lifetime — no further probes.
		const before = calls;
		expect(await detectConnectedWebBridge({ fetch: fetchImpl, now: () => 1e9, port: 4242 })).toEqual({ port: 4242 });
		expect(calls).toBe(before);
	});

	it("treats a daemon without a connected extension as absent", async () => {
		const fetchImpl = (async () =>
			Response.json({ ok: true, extensionConnected: false })) as unknown as typeof globalThis.fetch;
		expect(await detectConnectedWebBridge({ fetch: fetchImpl, now: () => 0, port: 4242 })).toBeUndefined();
	});

	it("suppresses re-probing for 30s after a negative, then retries", async () => {
		let calls = 0;
		let connected = false;
		const fetchImpl = (async () => {
			calls++;
			return Response.json({ ok: true, extensionConnected: connected });
		}) as unknown as typeof globalThis.fetch;

		expect(await detectConnectedWebBridge({ fetch: fetchImpl, now: () => 0, port: 4242 })).toBeUndefined();
		const afterFirst = calls;

		// Inside the negative TTL: no network at all, even though the daemon just came up.
		connected = true;
		expect(await detectConnectedWebBridge({ fetch: fetchImpl, now: () => 29_999, port: 4242 })).toBeUndefined();
		expect(calls).toBe(afterFirst);

		// Past the TTL: the mid-session daemon is picked up.
		expect(await detectConnectedWebBridge({ fetch: fetchImpl, now: () => 30_001, port: 4242 })).toEqual({
			port: 4242,
		});
		expect(calls).toBeGreaterThan(afterFirst);
	});

	it("reports absent when the daemon is unreachable", async () => {
		const fetchImpl = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof globalThis.fetch;
		expect(await detectConnectedWebBridge({ fetch: fetchImpl, now: () => 0, port: 4242 })).toBeUndefined();
	});
});
