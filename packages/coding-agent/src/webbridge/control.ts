/**
 * WebBridge daemon + install control plane.
 *
 * The single source of truth for the daemon lifecycle (status/start/stop) and
 * the extension install/uninstall flow, shared by the `loom webbridge` CLI
 * command and the `/webbridge` slash command so the two can never diverge.
 * Functions return structured results; callers own presentation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";
import { isDaemonRunning, WebBridgeDaemon } from "./daemon";
import { installWebBridgeExtension } from "./ext-assets";
import { ensureSigningKey, writeCrxArtifacts } from "./install/crx";
import { detectBrowsers, familyDisplayName } from "./install/detect";
import { installForcePolicy, removeForcePolicy } from "./install/policy";
import { BROWSER_FAMILIES, type BrowserFamily, type PolicyResult } from "./install/types";
import { WEBBRIDGE_HOST } from "./protocol";

/** `~/.omp/webbridge` — home for the extension, CRX artifacts, pid file, and daemon log. */
export function webBridgeDir(): string {
	return path.join(getConfigRootDir(), "webbridge");
}

export function pidFilePath(): string {
	return path.join(webBridgeDir(), "daemon.pid");
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export interface DaemonHealth {
	running: boolean;
	connected: boolean;
	version: string | null;
	port: number;
	url: string;
}

/** Probe the daemon `/health` endpoint. Never throws — a dead daemon reports `running: false`. */
export async function getDaemonHealth(port: number): Promise<DaemonHealth> {
	const url = `http://${WEBBRIDGE_HOST}:${port}`;
	try {
		const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
		const raw: unknown = await res.json();
		const record: Record<string, unknown> =
			raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const running = record.ok === true;
		return {
			running,
			connected: running && record.extensionConnected === true,
			version: typeof record.extensionVersion === "string" ? record.extensionVersion : null,
			port,
			url,
		};
	} catch {
		return { running: false, connected: false, version: null, port, url };
	}
}

export interface StartResult {
	started: boolean;
	alreadyRunning: boolean;
	pid?: number;
	url: string;
	logPath: string;
}

/**
 * Spawn the daemon detached in the background and wait until it answers
 * `/health`. Idempotent: a daemon already on `port` short-circuits.
 */
export async function startDaemon(port: number): Promise<StartResult> {
	const url = `http://${WEBBRIDGE_HOST}:${port}`;
	const logPath = path.join(webBridgeDir(), "daemon.log");
	if (await isDaemonRunning(port)) {
		return { started: false, alreadyRunning: true, url, logPath };
	}
	await fs.mkdir(webBridgeDir(), { recursive: true });
	const logFd = await fs.open(logPath, "a");
	try {
		const child = Bun.spawn([process.execPath, "webbridge", "serve", "--port", String(port)], {
			stdin: "ignore",
			stdout: logFd.fd,
			stderr: logFd.fd,
			env: process.env,
		});
		child.unref();
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (await isDaemonRunning(port)) {
				return { started: true, alreadyRunning: false, pid: child.pid, url, logPath };
			}
			await Bun.sleep(150);
		}
		child.kill();
		throw new Error(`webbridge daemon did not become healthy within 10s (see ${logPath})`);
	} finally {
		await logFd.close();
	}
}

/** Run the daemon in the foreground on `port` (blocks until signalled). Writes the pid file. */
export async function serveDaemon(port: number): Promise<void> {
	if (await isDaemonRunning(port)) {
		throw new Error(`webbridge daemon already running on port ${port}`);
	}
	const daemon = new WebBridgeDaemon({ port });
	daemon.start();
	await fs.mkdir(webBridgeDir(), { recursive: true });
	await fs.writeFile(pidFilePath(), String(process.pid), "utf8");
	let stopping = false;
	const shutdown = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		await daemon.stop();
		await fs.rm(pidFilePath(), { force: true });
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	await new Promise<never>(() => {});
}

export interface StopResult {
	stopped: boolean;
	pid?: number;
	reason?: string;
}

/** Signal a background daemon to stop via its pid file, then remove the file. */
export async function stopDaemon(): Promise<StopResult> {
	let pid: number | undefined;
	try {
		pid = Number((await fs.readFile(pidFilePath(), "utf8")).trim());
	} catch {}
	if (!pid || Number.isNaN(pid)) {
		return { stopped: false, reason: "no pid file" };
	}
	try {
		process.kill(pid, "SIGTERM");
		await fs.rm(pidFilePath(), { force: true });
		return { stopped: true, pid };
	} catch (error) {
		await fs.rm(pidFilePath(), { force: true });
		return { stopped: false, pid, reason: error instanceof Error ? error.message : String(error) };
	}
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

export interface InstallOptions {
	/** Destination for the unpacked extension. Default `~/.omp/webbridge/extension`. */
	dir?: string;
	/** Write the unpacked extension only; skip CRX packing + force-install (manual Developer-mode load). */
	dev: boolean;
	/** Machine-wide policy store (needs elevation) instead of per-user. */
	system: boolean;
	/** Retry with an interactive `sudo` (password prompt) when passwordless `sudo -n` fails. */
	interactiveSudo: boolean;
}

export interface InstallReport {
	destDir: string;
	/** True when only the unpacked extension was written (dev mode). */
	dev: boolean;
	/** True when no Chromium-family browser was detected (dev-load only). */
	noBrowsers: boolean;
	extensionId?: string;
	crxPath?: string;
	results: PolicyResult[];
}

/**
 * Write the unpacked extension, then (when a browser is present) pack a signed
 * CRX and force-install it via each detected browser family's enterprise policy.
 */
export async function installWebBridge(opts: InstallOptions): Promise<InstallReport> {
	const destDir = opts.dir ? path.resolve(opts.dir) : path.join(webBridgeDir(), "extension");
	await installWebBridgeExtension(destDir);

	if (opts.dev) {
		return { destDir, dev: true, noBrowsers: false, results: [] };
	}

	const browsers = detectBrowsers();
	if (browsers.length === 0) {
		return { destDir, dev: false, noBrowsers: true, results: [] };
	}

	const artifacts = await writeCrxArtifacts({
		extDir: destDir,
		outDir: webBridgeDir(),
		keyPath: path.join(webBridgeDir(), "signing-key.pem"),
	});

	const seen = new Set<BrowserFamily>();
	const results: PolicyResult[] = [];
	for (const browser of browsers) {
		if (seen.has(browser.family)) continue;
		seen.add(browser.family);
		results.push(
			await installForcePolicy({
				family: browser.family,
				extensionId: artifacts.extensionId,
				updateManifestPath: artifacts.updateManifestPath,
				system: opts.system,
				interactiveSudo: opts.interactiveSudo,
			}),
		);
	}
	return {
		destDir,
		dev: false,
		noBrowsers: false,
		extensionId: artifacts.extensionId,
		crxPath: artifacts.crxPath,
		results,
	};
}

export interface UninstallReport {
	/** True when no signing key exists — nothing was ever installed. */
	nothing: boolean;
	extensionId?: string;
	results: PolicyResult[];
}

/** Remove the loom force-install policy from every detected (or all known) browser family. */
export async function uninstallWebBridge(opts: {
	system: boolean;
	interactiveSudo: boolean;
}): Promise<UninstallReport> {
	const keyPath = path.join(webBridgeDir(), "signing-key.pem");
	let extensionId: string;
	try {
		await fs.access(keyPath);
		extensionId = (await ensureSigningKey(keyPath)).extensionId;
	} catch {
		return { nothing: true, results: [] };
	}

	const detected = detectBrowsers();
	const families = detected.length > 0 ? [...new Set(detected.map(browser => browser.family))] : [...BROWSER_FAMILIES];
	const results: PolicyResult[] = [];
	for (const family of families) {
		results.push(
			await removeForcePolicy({ family, extensionId, system: opts.system, interactiveSudo: opts.interactiveSudo }),
		);
	}
	return { nothing: false, extensionId, results };
}

/** Dev-mode load steps shown when force-install is skipped or a browser is missing. */
export function devLoadSteps(destDir: string): string {
	return [
		"Load it in your browser:",
		"  1. Open chrome://extensions (or edge://extensions)",
		"  2. Enable 'Developer mode' (top-right)",
		"  3. Click 'Load unpacked' and select:",
		`     ${destDir}`,
		"  4. Run `loom webbridge start` (or `/webbridge start`)",
	].join("\n");
}

/** Family display name — re-exported so presentation layers need not import from `install/detect`. */
export { familyDisplayName };

// ---------------------------------------------------------------------------
// Presentation — shared text formatters (CLI stdout + slash-command output)
// ---------------------------------------------------------------------------

export function formatHealth(h: DaemonHealth): string {
	if (!h.running) return `webbridge daemon: NOT running on port ${h.port}`;
	const ext = h.connected ? `connected${h.version ? ` (v${h.version})` : ""}` : "NOT connected";
	return `webbridge daemon: running on ${h.url}\nbrowser extension: ${ext}`;
}

export function formatStartResult(r: StartResult): string {
	if (r.alreadyRunning) return `webbridge daemon already running on ${r.url}`;
	return `webbridge daemon started on ${r.url}${r.pid ? ` (pid ${r.pid})` : ""}\nlogs: ${r.logPath}`;
}

export function formatStopResult(r: StopResult): string {
	if (r.stopped) return `stopped webbridge daemon${r.pid ? ` (pid ${r.pid})` : ""}`;
	if (r.reason === "no pid file") return "no webbridge daemon pid file found";
	return `could not stop webbridge daemon${r.pid ? ` (pid ${r.pid})` : ""}: ${r.reason ?? "unknown error"}`;
}

export function formatInstallReport(report: InstallReport): string {
	if (report.dev) {
		return `Loom WebBridge extension written to:\n  ${report.destDir}\n\n${devLoadSteps(report.destDir)}`;
	}
	if (report.noBrowsers) {
		return `No Chromium-family browser detected. Load the extension manually:\n\n${devLoadSteps(report.destDir)}`;
	}
	const lines = [`Loom WebBridge (extension id ${report.extensionId}):`, ""];
	for (const result of report.results) {
		lines.push(
			result.applied
				? `  \u2713 ${familyDisplayName(result.family)} — force-installed (${result.location})`
				: `  \u2717 ${familyDisplayName(result.family)} — ${result.message ?? "not applied"}`,
		);
	}
	lines.push("");
	if (report.results.some(r => r.applied)) {
		lines.push("Fully quit and reopen the browser — the extension installs automatically (no Developer mode).");
	}
	if (report.results.some(r => !r.applied)) {
		lines.push(
			"",
			"For any browser above, run the printed commands or load it manually:",
			"",
			devLoadSteps(report.destDir),
		);
	}
	lines.push("", "Then run `loom webbridge start` (or `/webbridge start`) to launch the daemon.");
	return lines.join("\n");
}

export function formatUninstallReport(report: UninstallReport): string {
	if (report.nothing) return "No Loom WebBridge signing key found; nothing to uninstall.";
	const lines = ["Loom WebBridge force-install policy:", ""];
	for (const result of report.results) {
		lines.push(
			`  ${result.applied ? "\u2713" : "\u2717"} ${familyDisplayName(result.family)} — ${result.message ?? "removed"} (${result.location})`,
		);
	}
	return lines.join("\n");
}
