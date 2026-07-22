import { describe, expect, it } from "bun:test";
import {
	formatHealth,
	formatInstallReport,
	formatStartResult,
	formatStopResult,
	formatUninstallReport,
	type InstallReport,
	type UninstallReport,
} from "../src/webbridge/control";

describe("formatHealth", () => {
	it("reports a stopped daemon with its port", () => {
		const out = formatHealth({
			running: false,
			connected: false,
			version: null,
			port: 10088,
			url: "http://127.0.0.1:10088",
		});
		expect(out).toContain("NOT running on port 10088");
	});

	it("reports a connected extension with its version", () => {
		const out = formatHealth({
			running: true,
			connected: true,
			version: "1",
			port: 10088,
			url: "http://127.0.0.1:10088",
		});
		expect(out).toContain("running on http://127.0.0.1:10088");
		expect(out).toContain("connected (v1)");
	});

	it("distinguishes a running daemon with no extension attached", () => {
		const out = formatHealth({
			running: true,
			connected: false,
			version: null,
			port: 10088,
			url: "http://127.0.0.1:10088",
		});
		expect(out).toContain("NOT connected");
	});
});

describe("formatStartResult", () => {
	it("short-circuits when already running", () => {
		expect(
			formatStartResult({ started: false, alreadyRunning: true, url: "http://127.0.0.1:10088", logPath: "/x" }),
		).toContain("already running");
	});

	it("shows pid and log path on a fresh start", () => {
		const out = formatStartResult({
			started: true,
			alreadyRunning: false,
			pid: 4242,
			url: "http://127.0.0.1:10088",
			logPath: "/tmp/d.log",
		});
		expect(out).toContain("started on http://127.0.0.1:10088");
		expect(out).toContain("pid 4242");
		expect(out).toContain("/tmp/d.log");
	});
});

describe("formatStopResult", () => {
	it("confirms a stop with the pid", () => {
		expect(formatStopResult({ stopped: true, pid: 7 })).toContain("stopped webbridge daemon (pid 7)");
	});

	it("reports a missing pid file distinctly", () => {
		expect(formatStopResult({ stopped: false, reason: "no pid file" })).toContain("no webbridge daemon pid file");
	});

	it("surfaces a kill failure reason", () => {
		expect(formatStopResult({ stopped: false, pid: 9, reason: "ESRCH" })).toContain("ESRCH");
	});
});

describe("formatInstallReport", () => {
	it("prints Developer-mode load steps in dev mode", () => {
		const report: InstallReport = { destDir: "/ext", dev: true, noBrowsers: false, results: [] };
		const out = formatInstallReport(report);
		expect(out).toContain("/ext");
		expect(out).toContain("Load unpacked");
	});

	it("falls back to manual load when no browser is detected", () => {
		const report: InstallReport = { destDir: "/ext", dev: false, noBrowsers: true, results: [] };
		expect(formatInstallReport(report)).toContain("No Chromium-family browser detected");
	});

	it("renders mixed per-family results with both success and manual-fallback blocks", () => {
		const report: InstallReport = {
			destDir: "/ext",
			dev: false,
			noBrowsers: false,
			extensionId: "abc",
			results: [
				{ family: "chrome", applied: true, location: "/etc/opt/chrome/policies/managed/loom-webbridge.json" },
				{
					family: "brave",
					applied: false,
					location: "/etc/brave/policies/managed/loom-webbridge.json",
					message: "Need root",
				},
			],
		};
		const out = formatInstallReport(report);
		expect(out).toContain("extension id abc");
		expect(out).toContain("\u2713"); // applied family
		expect(out).toContain("\u2717"); // failed family
		expect(out).toContain("Need root");
		expect(out).toContain("Fully quit and reopen");
		expect(out).toContain("loom webbridge start");
	});
});

describe("formatUninstallReport", () => {
	it("reports nothing to remove when no key exists", () => {
		const report: UninstallReport = { nothing: true, results: [] };
		expect(formatUninstallReport(report)).toContain("nothing to uninstall");
	});

	it("lists removed policies per family", () => {
		const report: UninstallReport = {
			nothing: false,
			results: [
				{ family: "chrome", applied: true, location: "/etc/opt/chrome/policies/managed/loom-webbridge.json" },
			],
		};
		expect(formatUninstallReport(report)).toContain("chrome");
	});
});
