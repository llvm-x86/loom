/**
 * `loom webbridge` — run the local browser WebBridge.
 *
 * The bridge lets loom drive the user's *real* browser (their live login
 * sessions) through a loopback HTTP endpoint: agents POST
 * `{action,args,session}` to `http://127.0.0.1:<port>/command`, the daemon
 * forwards it to a companion browser extension over WebSocket, and returns
 * `{ok,data}`. See `../webbridge/protocol.ts` for the wire contract and
 * `skill://loom-webbridge` for agent usage. Lifecycle + install logic lives in
 * `../webbridge/control.ts`, shared with the `/webbridge` slash command.
 *
 * Sub-verbs:
 *   install [--dev] [--system] [--launch]  — force-install the extension into every
 *                       detected Chromium-family browser via enterprise policy (permanent,
 *                       no Developer mode). Elevates with sudo automatically, prompting for
 *                       a password when needed; `--dev` writes it unpacked + prints load steps
 *   uninstall [--system] — remove the loom force-install policy (sudo as needed)
 *   serve   [--port]  — run the daemon in the foreground (blocks)
 *   start   [--port]  — spawn the daemon in the background, wait for health
 *   stop    [--port]  — stop a background daemon (via its pid file)
 *   status  [--port]  — print daemon + extension health as JSON
 *   call <action>     — POST one command to a running daemon (for testing)
 */
import { execFileSync, spawn } from "node:child_process";
import { logger } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { setTransports as setLoggerTransports } from "@oh-my-pi/pi-utils/logger";
import {
	ensureBrowserOpen,
	formatBrowserOpenResult,
	formatHealth,
	formatInstallReport,
	formatStartResult,
	formatStopResult,
	formatUninstallReport,
	getDaemonHealth,
	installWebBridge,
	serveDaemon,
	startDaemon,
	stopDaemon,
	uninstallWebBridge,
} from "../webbridge/control";
import { isDaemonRunning } from "../webbridge/daemon";
import { detectBrowsers, familyDisplayName } from "../webbridge/install/detect";
import { resolveWebBridgePort, WEBBRIDGE_HOST } from "../webbridge/protocol";

const WEBBRIDGE_ACTIONS = ["install", "uninstall", "serve", "start", "stop", "status", "call"] as const;

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
		session: Flags.string({
			description:
				'Tab-group id for `call` (default: auto — the tmux session name, or $LOOM_WEBBRIDGE_SESSION, else "default")',
		}),
		json: Flags.boolean({ description: "Output JSON" }),
		dev: Flags.boolean({
			description:
				"install: only write the unpacked extension + print Developer-mode load steps (skip force-install)",
		}),
		system: Flags.boolean({ description: "install/uninstall: use the machine-wide policy store (needs elevation)" }),
		launch: Flags.boolean({ description: "install: launch the browser afterward to apply the policy" }),
		open: Flags.boolean({
			description:
				"start: open + focus your browser afterward so the extension connects (default on; --no-open to skip)",
			allowNo: true,
			default: true,
		}),
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
				return this.#start(port, flags.open);
			case "stop":
				return this.#stop();
			case "status":
				return this.#status(port, Boolean(flags.json));
			case "call":
				return this.#call(port, args.target, flags.args, this.#resolveSession(flags.session));
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
		// CLI runs on a real TTY, so interactive sudo can prompt for a password.
		const report = await installWebBridge({
			dir: opts.dir,
			dev: opts.dev,
			system: opts.system,
			interactiveSudo: true,
		});
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ destDir: report.destDir, dev: report.dev, noBrowsers: report.noBrowsers, extensionId: report.extensionId, crxPath: report.crxPath, results: report.results }, null, 2)}\n`,
			);
			return;
		}
		process.stdout.write(`${formatInstallReport(report)}\n`);
		if (opts.launch && !report.dev && !report.noBrowsers) {
			const target = detectBrowsers()[0];
			if (target) {
				spawn(target.executablePath, [], { detached: true, stdio: "ignore" }).unref();
				process.stdout.write(`\nLaunched ${familyDisplayName(target.family)}.\n`);
			}
		}
	}

	async #uninstall(opts: { system: boolean; json: boolean }): Promise<void> {
		const report = await uninstallWebBridge({ system: opts.system, interactiveSudo: true });
		if (opts.json) {
			process.stdout.write(
				`${JSON.stringify({ nothing: report.nothing, extensionId: report.extensionId, results: report.results }, null, 2)}\n`,
			);
			return;
		}
		process.stdout.write(`${formatUninstallReport(report)}\n`);
	}

	async #serve(port: number): Promise<void> {
		// Headless service: route logs to stdout so a supervisor captures them.
		setLoggerTransports({ console: true, file: false });
		if (await isDaemonRunning(port)) {
			logger.warn(`webbridge daemon already running on port ${port}`);
			return;
		}
		await serveDaemon(port);
	}

	async #start(port: number, open: boolean): Promise<void> {
		process.stdout.write(`${formatStartResult(await startDaemon(port))}\n`);
		if (open) {
			process.stdout.write(`${formatBrowserOpenResult(await ensureBrowserOpen(port))}\n`);
		}
	}

	async #stop(): Promise<void> {
		process.stdout.write(`${formatStopResult(await stopDaemon())}\n`);
	}

	async #status(port: number, json: boolean): Promise<void> {
		const health = await getDaemonHealth(port);
		if (json) {
			process.stdout.write(
				`${JSON.stringify({ ok: health.running, running: health.running, extensionConnected: health.connected, extensionVersion: health.version, port: health.port })}\n`,
			);
			return;
		}
		process.stdout.write(`${formatHealth(health)}\n`);
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
		process.stderr.write(`webbridge: session "${session}" → tab group loom:${session}\n`);
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

	/**
	 * Pick the tab-group id for a `call` so concurrent loom sessions land in
	 * separate browser tab groups automatically. Precedence: explicit
	 * `--session` › `$LOOM_WEBBRIDGE_SESSION` › the tmux session name (each
	 * workstream on the box is its own tmux session) › `"default"`.
	 */
	#resolveSession(explicit: string | undefined): string {
		const clean = (value: string | undefined): string | undefined => {
			const trimmed = value?.trim();
			return trimmed && trimmed !== "default" ? trimmed : undefined;
		};
		const chosen = clean(explicit) ?? clean(process.env.LOOM_WEBBRIDGE_SESSION);
		if (chosen) return chosen;
		if (process.env.TMUX) {
			try {
				const name = execFileSync("tmux", ["display-message", "-p", "#S"], {
					encoding: "utf8",
					timeout: 1_000,
				}).trim();
				if (name) return name;
			} catch {}
		}
		return "default";
	}
}
