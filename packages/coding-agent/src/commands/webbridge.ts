/**
 * `loom webbridge` — run the local browser WebBridge.
 *
 * The bridge lets loom drive the user's *real* browser (their live login
 * sessions) through a loopback HTTP endpoint: agents POST
 * `{action,args,session}` to `http://127.0.0.1:<port>/command`, the daemon
 * forwards it to a companion browser extension over WebSocket, and returns
 * `{ok,data}`. See `../webbridge/protocol.ts` for the wire contract and
 * `skill://loom-webbridge` for agent usage.
 *
 * Sub-verbs:
 *   install [--dev] [--system] [--launch]  — force-install the extension into every
 *                       detected Chromium-family browser via enterprise policy (permanent,
 *                       no Developer mode); `--dev` writes it unpacked + prints load steps
 *   uninstall [--system] — remove the loom force-install policy
 *   serve   [--port]  — run the daemon in the foreground (blocks)
 *   start   [--port]  — spawn the daemon in the background, wait for health
 *   stop    [--port]  — stop a background daemon (via its pid file)
 *   status  [--port]  — print daemon + extension health as JSON
 *   call <action>     — POST one command to a running daemon (for testing)
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, logger } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { setTransports as setLoggerTransports } from "@oh-my-pi/pi-utils/logger";
import { isDaemonRunning, WebBridgeDaemon } from "../webbridge/daemon";
import { installWebBridgeExtension } from "../webbridge/ext-assets";
import { ensureSigningKey, writeCrxArtifacts } from "../webbridge/install/crx";
import { detectBrowsers, familyDisplayName } from "../webbridge/install/detect";
import { installForcePolicy, removeForcePolicy } from "../webbridge/install/policy";
import type { BrowserFamily, PolicyResult } from "../webbridge/install/types";
import { BROWSER_FAMILIES } from "../webbridge/install/types";
import { resolveWebBridgePort, WEBBRIDGE_HOST } from "../webbridge/protocol";

const WEBBRIDGE_ACTIONS = ["install", "uninstall", "serve", "start", "stop", "status", "call"] as const;

function webBridgeDir(): string {
	return path.join(getConfigRootDir(), "webbridge");
}

function pidFilePath(): string {
	return path.join(webBridgeDir(), "daemon.pid");
}

export default class WebBridge extends Command {
	static description = "Run the local browser WebBridge (drive your real browser from loom)";

	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...WEBBRIDGE_ACTIONS],
		}),
		target: Args.string({ description: "Action name for `call`", required: false }),
	};

	static flags = {
		port: Flags.integer({ description: "Daemon port (default 10088, or LOOM_WEBBRIDGE_PORT)", char: "p" }),
		dir: Flags.string({ description: "Destination directory for `install`" }),
		args: Flags.string({ description: "JSON args object for `call`" }),
		session: Flags.string({ description: "Session id for `call`", default: "default" }),
		json: Flags.boolean({ description: "Output JSON" }),
		dev: Flags.boolean({
			description:
				"install: only write the unpacked extension + print Developer-mode load steps (skip force-install)",
		}),
		system: Flags.boolean({ description: "install/uninstall: use the machine-wide policy store (needs elevation)" }),
		launch: Flags.boolean({ description: "install: launch the browser afterward to apply the policy" }),
	};

	static examples = [
		"# Permanently force-install into every detected browser (no Developer mode)\n  loom webbridge install",
		"# Start the bridge daemon in the background\n  loom webbridge start",
		"# Check daemon + extension health\n  loom webbridge status",
		'# Drive the browser from the shell\n  loom webbridge call navigate --args \'{"url":"example.com"}\'',
		"# Stop the background daemon\n  loom webbridge stop",
		"# Remove the force-install policy\n  loom webbridge uninstall",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(WebBridge);
		const port = flags.port ?? resolveWebBridgePort();
		switch (args.action) {
			case "install":
				return this.#install({
					dir: flags.dir,
					dev: Boolean(flags.dev),
					system: Boolean(flags.system),
					launch: Boolean(flags.launch),
					json: Boolean(flags.json),
				});
			case "uninstall":
				return this.#uninstall({ system: Boolean(flags.system), json: Boolean(flags.json) });
			case "serve":
				return this.#serve(port);
			case "start":
				return this.#start(port);
			case "stop":
				return this.#stop();
			case "status":
				return this.#status(port, Boolean(flags.json));
			case "call":
				return this.#call(port, args.target, flags.args, flags.session ?? "default");
			default:
				process.stdout.write(
					`Usage: loom webbridge <${WEBBRIDGE_ACTIONS.join("|")}>\n\nRun \`loom webbridge install\` first, load the extension, then \`loom webbridge start\`.\n`,
				);
		}
	}

	async #install(opts: {
		dir?: string;
		dev: boolean;
		system: boolean;
		launch: boolean;
		json: boolean;
	}): Promise<void> {
		const destDir = opts.dir ? path.resolve(opts.dir) : path.join(webBridgeDir(), "extension");
		await installWebBridgeExtension(destDir);

		const devSteps = [
			"Load it in your browser:",
			"  1. Open chrome://extensions (or edge://extensions)",
			"  2. Enable 'Developer mode' (top-right)",
			"  3. Click 'Load unpacked' and select:",
			`     ${destDir}`,
			"  4. Run `loom webbridge start`",
			"",
		].join("\n");

		if (opts.dev) {
			process.stdout.write(`Loom WebBridge extension written to:\n  ${destDir}\n\n${devSteps}`);
			return;
		}

		const browsers = detectBrowsers();
		if (browsers.length === 0) {
			process.stdout.write(`No Chromium-family browser detected. Load the extension manually:\n\n${devSteps}`);
			return;
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
				}),
			);
		}

		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ extensionId: artifacts.extensionId, crxPath: artifacts.crxPath, results }, null, 2)}\n`,
			);
			return;
		}

		const lines = [`Loom WebBridge (extension id ${artifacts.extensionId}):`, ""];
		for (const result of results) {
			lines.push(
				result.applied
					? `  \u2713 ${familyDisplayName(result.family)} — force-installed (${result.location})`
					: `  \u2717 ${familyDisplayName(result.family)} — ${result.message ?? "not applied"}`,
			);
		}
		lines.push("");
		if (results.some(result => result.applied)) {
			lines.push("Fully quit and reopen the browser — the extension installs automatically (no Developer mode).");
		}
		if (results.some(result => !result.applied)) {
			lines.push("", "For any browser above, run the printed commands or load it manually:", "", devSteps);
		}
		lines.push("", "Then run `loom webbridge start` to launch the daemon.", "");
		process.stdout.write(lines.join("\n"));

		if (opts.launch) {
			const target = browsers[0];
			spawn(target.executablePath, [], { detached: true, stdio: "ignore" }).unref();
			process.stdout.write(`\nLaunched ${familyDisplayName(target.family)}.\n`);
		}
	}

	async #uninstall(opts: { system: boolean; json: boolean }): Promise<void> {
		const keyPath = path.join(webBridgeDir(), "signing-key.pem");
		let extensionId: string;
		try {
			await fs.access(keyPath);
			extensionId = (await ensureSigningKey(keyPath)).extensionId;
		} catch {
			process.stdout.write("No Loom WebBridge signing key found; nothing to uninstall.\n");
			return;
		}

		const detected = detectBrowsers();
		const families =
			detected.length > 0 ? [...new Set(detected.map(browser => browser.family))] : [...BROWSER_FAMILIES];
		const results: PolicyResult[] = [];
		for (const family of families) {
			results.push(await removeForcePolicy({ family, extensionId, system: opts.system }));
		}

		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ extensionId, results }, null, 2)}\n`);
			return;
		}
		const lines = ["Loom WebBridge force-install policy:", ""];
		for (const result of results) {
			lines.push(
				`  ${result.applied ? "\u2713" : "\u2717"} ${familyDisplayName(result.family)} — ${result.message ?? "removed"} (${result.location})`,
			);
		}
		lines.push("");
		process.stdout.write(lines.join("\n"));
	}

	async #serve(port: number): Promise<void> {
		// Headless service: route logs to stdout so a supervisor captures them.
		setLoggerTransports({ console: true, file: false });
		if (await isDaemonRunning(port)) {
			logger.warn(`webbridge daemon already running on port ${port}`);
			return;
		}
		const daemon = new WebBridgeDaemon({ port });
		daemon.start();
		await fs.mkdir(webBridgeDir(), { recursive: true });
		await fs.writeFile(pidFilePath(), String(process.pid), "utf8");
		let stopping = false;
		const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
			if (stopping) return;
			stopping = true;
			logger.info(`webbridge daemon shutting down (${signal})`);
			await daemon.stop();
			await fs.rm(pidFilePath(), { force: true });
			process.exit(0);
		};
		process.on("SIGINT", () => void shutdown("SIGINT"));
		process.on("SIGTERM", () => void shutdown("SIGTERM"));

		// Block forever; the daemon runs on Bun.serve.
		await new Promise<never>(() => {});
	}

	async #start(port: number): Promise<void> {
		if (await isDaemonRunning(port)) {
			process.stdout.write(`webbridge daemon already running on http://${WEBBRIDGE_HOST}:${port}\n`);
			return;
		}
		await fs.mkdir(webBridgeDir(), { recursive: true });
		const logPath = path.join(webBridgeDir(), "daemon.log");
		const logFd = await fs.open(logPath, "a");
		const child = Bun.spawn([process.execPath, "webbridge", "serve", "--port", String(port)], {
			stdin: "ignore",
			stdout: logFd.fd,
			stderr: logFd.fd,
			env: process.env,
		});
		child.unref();
		// Wait for the daemon to answer /health before returning.
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (await isDaemonRunning(port)) {
				await logFd.close();
				process.stdout.write(
					`webbridge daemon started on http://${WEBBRIDGE_HOST}:${port} (pid ${child.pid}); logs: ${logPath}\n`,
				);
				return;
			}
			await Bun.sleep(150);
		}
		await logFd.close();
		throw new Error(`webbridge daemon did not become healthy within 10s (see ${logPath})`);
	}

	async #stop(): Promise<void> {
		let pid: number | undefined;
		try {
			pid = Number((await fs.readFile(pidFilePath(), "utf8")).trim());
		} catch {}
		if (!pid || Number.isNaN(pid)) {
			process.stdout.write("no webbridge daemon pid file found\n");
			return;
		}
		try {
			process.kill(pid, "SIGTERM");
			process.stdout.write(`sent SIGTERM to webbridge daemon (pid ${pid})\n`);
		} catch (error) {
			process.stdout.write(
				`could not signal pid ${pid}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
		}
		await fs.rm(pidFilePath(), { force: true });
	}

	async #status(port: number, json: boolean): Promise<void> {
		let health: unknown;
		try {
			const res = await fetch(`http://${WEBBRIDGE_HOST}:${port}/health`, { signal: AbortSignal.timeout(2_000) });
			health = await res.json();
		} catch {
			health = { ok: false, running: false, port };
		}
		if (json) {
			process.stdout.write(`${JSON.stringify(health)}\n`);
			return;
		}
		// Narrow the external /health payload to a generic record, then read fields defensively.
		const record: Record<string, unknown> =
			health !== null && typeof health === "object" ? (health as Record<string, unknown>) : {};
		const ok = "ok" in record && record.ok === true;
		if (!ok) {
			process.stdout.write(`webbridge daemon: NOT running on port ${port}\n`);
			return;
		}
		const connected = "extensionConnected" in record && record.extensionConnected === true;
		const version =
			"extensionVersion" in record && typeof record.extensionVersion === "string" ? record.extensionVersion : "?";
		process.stdout.write(
			`webbridge daemon: running on http://${WEBBRIDGE_HOST}:${port}\nbrowser extension: ${connected ? `connected (v${version})` : "NOT connected"}\n`,
		);
	}

	async #call(port: number, action: string | undefined, argsJson: string | undefined, session: string): Promise<void> {
		if (!action) throw new Error("usage: loom webbridge call <action> [--args '<json>'] [--session <id>]");
		let parsedArgs: unknown = {};
		if (argsJson) {
			try {
				parsedArgs = JSON.parse(argsJson);
			} catch {
				throw new Error(`--args must be valid JSON (got: ${argsJson})`);
			}
		}
		const res = await fetch(`http://${WEBBRIDGE_HOST}:${port}/command`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, args: parsedArgs, session }),
		});
		const body: unknown = await res.json();
		process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
		const ok = body !== null && typeof body === "object" && "ok" in body && body.ok === true;
		if (!ok) process.exitCode = 1;
	}
}
