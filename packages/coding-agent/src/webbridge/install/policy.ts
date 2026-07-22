/**
 * Enterprise-policy writer: force-install (and un-force-install) the loom
 * WebBridge extension in a Chromium-family browser.
 *
 * Force-installation adds `<extensionId>;<updateUrl>` to the browser's
 * `ExtensionInstallForcelist` enterprise policy, where the update URL is a
 * `file://` URL pointing at the local Omaha `update.xml` (see crx.ts). The
 * policy store is OS-specific:
 *   - win32  — registry `...\ExtensionInstallForcelist` (HKCU, or HKLM with `system`)
 *   - darwin — `defaults` array (user domain, or /Library/Managed Preferences with `system`)
 *   - linux  — JSON file in `/etc/<...>/policies/managed` (always system-wide)
 *
 * Expected permission failures never throw: both exports return
 * `applied: false` with a message containing the exact commands the user can
 * run instead. Only real bugs (e.g. a missing updateManifestPath) throw.
 */
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { BrowserFamily, PolicyOptions, PolicyResult } from "./types";

const execFileAsync = promisify(execFile);

const RESTART_NOTE = "Fully quit and reopen the browser for the policy to load.";

const WINDOWS_POLICY_SUBKEYS: Record<BrowserFamily, string> = {
	chrome: "Software\\Policies\\Google\\Chrome",
	chromium: "Software\\Policies\\Chromium",
	edge: "Software\\Policies\\Microsoft\\Edge",
	brave: "Software\\Policies\\BraveSoftware\\Brave",
};

const MACOS_POLICY_DOMAINS: Record<BrowserFamily, string> = {
	chrome: "com.google.Chrome",
	chromium: "org.chromium.Chromium",
	edge: "com.microsoft.Edge",
	brave: "com.brave.Browser",
};

const LINUX_POLICY_DIRS: Record<BrowserFamily, string> = {
	chrome: "/etc/opt/chrome/policies/managed",
	chromium: "/etc/chromium/policies/managed",
	edge: "/etc/opt/edge/policies/managed",
	brave: "/etc/brave/policies/managed",
};

const LINUX_POLICY_FILENAME = "loom-webbridge.json";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Force-install the extension via the OS policy store for `opts.family`. Idempotent. */
export async function installForcePolicy(opts: PolicyOptions): Promise<PolicyResult> {
	if (!opts.updateManifestPath) {
		throw new TypeError("installForcePolicy requires opts.updateManifestPath (absolute path to update.xml)");
	}
	const entry = `${opts.extensionId};${pathToFileURL(opts.updateManifestPath).href}`;
	switch (process.platform) {
		case "win32":
			return installWindows(opts, entry);
		case "darwin":
			return installMacOS(opts, entry);
		case "linux":
			return installLinux(opts, entry);
		default:
			return {
				family: opts.family,
				applied: false,
				location: "",
				message: `Unsupported platform "${process.platform}"; force-install policies are implemented for win32, darwin, and linux.`,
			};
	}
}

/** Remove only the loom force-install entry, preserving other forced extensions where possible. */
export async function removeForcePolicy(opts: PolicyOptions): Promise<PolicyResult> {
	switch (process.platform) {
		case "win32":
			return removeWindows(opts);
		case "darwin":
			return removeMacOS(opts);
		case "linux":
			return removeLinux(opts);
		default:
			return {
				family: opts.family,
				applied: false,
				location: "",
				message: `Unsupported platform "${process.platform}"; force-install policies are implemented for win32, darwin, and linux.`,
			};
	}
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

async function run(command: string, args: string[]): Promise<CommandResult> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, { encoding: "utf8" });
		return { ok: true, stdout, stderr };
	} catch (error) {
		let stdout = "";
		let stderr = "";
		if (typeof error === "object" && error !== null) {
			if ("stdout" in error && typeof error.stdout === "string") stdout = error.stdout;
			if ("stderr" in error && typeof error.stderr === "string") stderr = error.stderr;
		}
		return { ok: false, stdout, stderr };
	}
}

function shellQuote(value: string): string {
	const escaped = value.replace(/'/g, `'\\''`);
	return `'${escaped}'`;
}

// ---------------------------------------------------------------------------
// win32 — registry ExtensionInstallForcelist
// ---------------------------------------------------------------------------

interface RegistryValue {
	name: string;
	data: string;
}

async function queryRegistryValues(key: string): Promise<RegistryValue[]> {
	const query = await run("reg", ["query", key]);
	if (!query.ok) return [];
	const values: RegistryValue[] = [];
	for (const line of query.stdout.split(/\r?\n/)) {
		const match = /^\s+(\S+)\s+REG_SZ\s+(.*)$/.exec(line);
		if (match) values.push({ name: match[1], data: match[2] });
	}
	return values;
}

async function installWindows(opts: PolicyOptions, entry: string): Promise<PolicyResult> {
	const key = `${opts.system ? "HKLM" : "HKCU"}\\${WINDOWS_POLICY_SUBKEYS[opts.family]}\\ExtensionInstallForcelist`;
	const values = await queryRegistryValues(key);
	const prefix = `${opts.extensionId};`;
	if (values.some(value => value.data.startsWith(prefix))) {
		return { family: opts.family, applied: true, location: key, message: `Policy already present. ${RESTART_NOTE}` };
	}
	let nextIndex = 1;
	for (const value of values) {
		const index = Number.parseInt(value.name, 10);
		if (Number.isFinite(index) && index >= nextIndex) nextIndex = index + 1;
	}
	const added = await run("reg", ["add", key, "/v", String(nextIndex), "/t", "REG_SZ", "/d", entry, "/f"]);
	if (!added.ok) {
		const elevation = opts.system ? " (HKLM requires an elevated shell)" : "";
		const detail = added.stderr.trim() || added.stdout.trim() || "reg add failed";
		return {
			family: opts.family,
			applied: false,
			location: key,
			message: `Could not write the force-install policy${elevation}: ${detail}`,
		};
	}
	return { family: opts.family, applied: true, location: key, message: RESTART_NOTE };
}

async function removeWindows(opts: PolicyOptions): Promise<PolicyResult> {
	const key = `${opts.system ? "HKLM" : "HKCU"}\\${WINDOWS_POLICY_SUBKEYS[opts.family]}\\ExtensionInstallForcelist`;
	const values = await queryRegistryValues(key);
	const prefix = `${opts.extensionId};`;
	const target = values.find(value => value.data.startsWith(prefix));
	if (!target) {
		return {
			family: opts.family,
			applied: true,
			location: key,
			message: "No loom force-install entry present; nothing to remove.",
		};
	}
	const deleted = await run("reg", ["delete", key, "/v", target.name, "/f"]);
	if (!deleted.ok) {
		const elevation = opts.system ? " (HKLM requires an elevated shell)" : "";
		const detail = deleted.stderr.trim() || deleted.stdout.trim() || "reg delete failed";
		return {
			family: opts.family,
			applied: false,
			location: key,
			message: `Could not remove the force-install entry${elevation}: ${detail}`,
		};
	}
	return { family: opts.family, applied: true, location: key, message: RESTART_NOTE };
}

// ---------------------------------------------------------------------------
// darwin — defaults ExtensionInstallForcelist array
// ---------------------------------------------------------------------------

interface DefaultsTarget {
	command: string;
	prefix: string[];
	domain: string;
}

function macTarget(family: BrowserFamily, system: boolean | undefined): DefaultsTarget {
	const domain = MACOS_POLICY_DOMAINS[family];
	if (system) {
		return { command: "sudo", prefix: ["-n", "defaults"], domain: `/Library/Managed Preferences/${domain}` };
	}
	return { command: "defaults", prefix: [], domain };
}

function parseDefaultsArray(stdout: string): string[] {
	const entries: string[] = [];
	for (const rawLine of stdout.split("\n")) {
		let line = rawLine.trim();
		if (line === "" || line === "(" || line === ")" || line === ");") continue;
		if (line.endsWith(",")) line = line.slice(0, -1);
		if (line.startsWith('"') && line.endsWith('"') && line.length >= 2) line = line.slice(1, -1);
		entries.push(line);
	}
	return entries;
}

async function readMacForcelist(target: DefaultsTarget): Promise<string[]> {
	const read = await run(target.command, [...target.prefix, "read", target.domain, "ExtensionInstallForcelist"]);
	if (!read.ok) return [];
	return parseDefaultsArray(read.stdout);
}

async function installMacOS(opts: PolicyOptions, entry: string): Promise<PolicyResult> {
	const target = macTarget(opts.family, opts.system);
	const existing = await readMacForcelist(target);
	const prefix = `${opts.extensionId};`;
	if (existing.some(item => item.startsWith(prefix))) {
		return {
			family: opts.family,
			applied: true,
			location: target.domain,
			message: `Policy already present. ${RESTART_NOTE}`,
		};
	}
	const entries = [...existing, entry];
	const written = await run(target.command, [
		...target.prefix,
		"write",
		target.domain,
		"ExtensionInstallForcelist",
		"-array",
		...entries,
	]);
	if (!written.ok) {
		const printable = [
			target.command,
			...target.prefix,
			"write",
			target.domain,
			"ExtensionInstallForcelist",
			"-array",
			...entries,
		]
			.map(shellQuote)
			.join(" ");
		const detail = written.stderr.trim() || "defaults write failed";
		return {
			family: opts.family,
			applied: false,
			location: target.domain,
			message: `Could not write the force-install policy (${detail}). Run it yourself:\n${printable}\n${RESTART_NOTE}`,
		};
	}
	return { family: opts.family, applied: true, location: target.domain, message: RESTART_NOTE };
}

async function removeMacOS(opts: PolicyOptions): Promise<PolicyResult> {
	const target = macTarget(opts.family, opts.system);
	const existing = await readMacForcelist(target);
	const prefix = `${opts.extensionId};`;
	const remaining = existing.filter(item => !item.startsWith(prefix));
	if (remaining.length === existing.length) {
		return {
			family: opts.family,
			applied: true,
			location: target.domain,
			message: "No loom force-install entry present; nothing to remove.",
		};
	}
	const removed =
		remaining.length === 0
			? await run(target.command, [...target.prefix, "delete", target.domain, "ExtensionInstallForcelist"])
			: await run(target.command, [
					...target.prefix,
					"write",
					target.domain,
					"ExtensionInstallForcelist",
					"-array",
					...remaining,
				]);
	if (!removed.ok) {
		const detail = removed.stderr.trim() || "defaults failed";
		return {
			family: opts.family,
			applied: false,
			location: target.domain,
			message: `Could not remove the force-install entry: ${detail}`,
		};
	}
	return { family: opts.family, applied: true, location: target.domain, message: RESTART_NOTE };
}

// ---------------------------------------------------------------------------
// linux — managed policy JSON file (system-wide, needs root)
// ---------------------------------------------------------------------------

async function readLinuxForcelist(file: string): Promise<string[]> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || !("ExtensionInstallForcelist" in parsed)) return [];
		const list = parsed.ExtensionInstallForcelist;
		if (!Array.isArray(list)) return [];
		return list.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

async function canWriteDirectly(dir: string): Promise<boolean> {
	if (process.getuid?.() === 0) return true;
	try {
		await fs.access(dir, fsConstants.W_OK);
		return true;
	} catch {
		return false;
	}
}

async function installLinux(opts: PolicyOptions, entry: string): Promise<PolicyResult> {
	const dir = LINUX_POLICY_DIRS[opts.family];
	const file = path.join(dir, LINUX_POLICY_FILENAME);
	const prefix = `${opts.extensionId};`;
	const existing = await readLinuxForcelist(file);
	if (existing.some(item => item.startsWith(prefix))) {
		return { family: opts.family, applied: true, location: file, message: `Policy already present. ${RESTART_NOTE}` };
	}
	const content = `${JSON.stringify({ ExtensionInstallForcelist: [...existing, entry] }, null, "\t")}\n`;

	if (await canWriteDirectly(dir)) {
		try {
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(file, content, "utf8");
			return { family: opts.family, applied: true, location: file, message: RESTART_NOTE };
		} catch {
			// Direct write failed despite the writability check — try elevation.
		}
	}

	const script = 'mkdir -p "$1" && printf "%s" "$2" > "$3"';
	const elevated = await run("sudo", ["-n", "sh", "-c", script, "sh", dir, content, file]);
	if (elevated.ok) {
		return { family: opts.family, applied: true, location: file, message: RESTART_NOTE };
	}
	return {
		family: opts.family,
		applied: false,
		location: file,
		message: [
			`Need root to write the managed policy for ${opts.family}. Paste these commands:`,
			`sudo mkdir -p ${shellQuote(dir)}`,
			`sudo tee ${shellQuote(file)} <<'EOF'\n${content}EOF`,
		].join("\n"),
	};
}

async function removeLinux(opts: PolicyOptions): Promise<PolicyResult> {
	const dir = LINUX_POLICY_DIRS[opts.family];
	const file = path.join(dir, LINUX_POLICY_FILENAME);
	try {
		await fs.access(file);
	} catch {
		return {
			family: opts.family,
			applied: true,
			location: file,
			message: "No loom policy file present; nothing to remove.",
		};
	}
	if (await canWriteDirectly(dir)) {
		try {
			await fs.rm(file, { force: true });
			return { family: opts.family, applied: true, location: file };
		} catch {
			// Direct remove failed despite the writability check — try elevation.
		}
	}
	const elevated = await run("sudo", ["-n", "rm", "-f", file]);
	if (elevated.ok) {
		return { family: opts.family, applied: true, location: file };
	}
	return {
		family: opts.family,
		applied: false,
		location: file,
		message: `Need root to remove the managed policy. Run: sudo rm -f ${shellQuote(file)}`,
	};
}
