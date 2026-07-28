/**
 * Detects whether the loom WebBridge daemon is up AND has the browser
 * extension connected, i.e. whether the user's REAL browser (with their live
 * login sessions) is drivable right now.
 *
 * The browser tool uses this to refuse a silent headless Chromium launch when
 * a far better target is sitting there — the failure mode observed on Windows,
 * where the agent had the bridge running and still ended up in a hidden
 * headless browser.
 *
 * Caching is asymmetric on purpose: a connected bridge cannot un-become the
 * right answer often enough to matter, so positives are cached for the process
 * lifetime; negatives expire after `NEGATIVE_CACHE_MS` so a daemon started
 * mid-session is picked up without paying the probe cost on every `open`.
 */

import { resolveWebBridgePort, WEBBRIDGE_HOST } from "../../webbridge/protocol";

/** Wall-clock budget for the whole probe. Loopback; anything slower is not worth waiting for. */
const PROBE_TIMEOUT_MS = 300;

/** How long a "no bridge" answer is trusted before re-probing. */
const NEGATIVE_CACHE_MS = 30_000;

/**
 * Status paths to try. `/health` is what the daemon serves today; `/status` is
 * the documented alias. Probing both keeps detection working across versions.
 */
const STATUS_PATHS = ["/status", "/health"] as const;

/** A reachable WebBridge daemon with a connected extension. */
export interface WebBridgeConnection {
	port: number;
}

/** Injectable seams so tests never touch the network or the real clock. */
export interface WebBridgeProbeDeps {
	fetch: typeof globalThis.fetch;
	now: () => number;
	port: number;
}

/** Signature the browser tool depends on; overridable for tests. */
export type WebBridgeDetector = () => Promise<WebBridgeConnection | undefined>;

let cachedConnection: WebBridgeConnection | undefined;
let negativeUntil = 0;

/** Clears both cache halves. Test-only seam. */
export function resetWebBridgeDetectionCache(): void {
	cachedConnection = undefined;
	negativeUntil = 0;
}

async function statusReportsConnectedExtension(
	fetchImpl: typeof globalThis.fetch,
	url: string,
	signal: AbortSignal,
): Promise<boolean> {
	try {
		const response = await fetchImpl(url, { signal });
		if (!response.ok) return false;
		const body = (await response.json()) as { ok?: unknown; extensionConnected?: unknown };
		return body.ok === true && body.extensionConnected === true;
	} catch {
		return false;
	}
}

/**
 * Resolves the WebBridge port when a daemon answers with
 * `{ok: true, extensionConnected: true}`, otherwise `undefined`.
 */
export async function detectConnectedWebBridge(
	deps?: Partial<WebBridgeProbeDeps>,
): Promise<WebBridgeConnection | undefined> {
	const fetchImpl = deps?.fetch ?? globalThis.fetch;
	const now = deps?.now ?? Date.now;
	const port = deps?.port ?? resolveWebBridgePort();

	if (cachedConnection?.port === port) return cachedConnection;
	if (now() < negativeUntil) return undefined;

	const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	const probes = STATUS_PATHS.map(path =>
		statusReportsConnectedExtension(fetchImpl, `http://${WEBBRIDGE_HOST}:${port}${path}`, signal),
	);
	const connected = (await Promise.all(probes)).some(Boolean);

	if (connected) {
		cachedConnection = { port };
		negativeUntil = 0;
		return cachedConnection;
	}
	negativeUntil = now() + NEGATIVE_CACHE_MS;
	return undefined;
}

/** Steering text shown instead of launching headless behind the user's back. */
export function webBridgeRoutingMessage(port: number): string {
	const base = `http://${WEBBRIDGE_HOST}:${port}`;
	return [
		`The user's REAL browser is available through the loom WebBridge on ${WEBBRIDGE_HOST}:${port} (daemon up, extension connected).`,
		"Refusing to launch a hidden headless Chromium instead — it would not have the user's login sessions.",
		"Read skill://loom-webbridge, then drive the real browser with bash:",
		`  curl -s -X POST ${base}/command -H 'content-type: application/json' -d '{"action":"navigate","args":{"url":"https://example.com"}}'`,
		"  loom webbridge call snapshot --args '{}'",
		"Headless is still available on purpose: pass an explicit app.path or app.cdp_url, or stop the WebBridge daemon / disconnect the extension.",
	].join("\n");
}
