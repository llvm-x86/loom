/**
 * Shared contract for the WebBridge easy-install subsystem.
 *
 * "Permanent, non-developer-mode" installation works by force-installing a
 * signed CRX through each browser's enterprise policy store, pointed at a local
 * `update.xml` (Omaha protocol) with a `file://` codebase. Force-installed
 * extensions install automatically, survive restarts, need no Developer mode,
 * and are not nagged — and, uniquely, MAY be sourced from off the Web Store.
 *
 * Modules:
 *   - crx.ts    — sign key + CRX3 pack + deterministic extension id + update.xml
 *   - detect.ts — enumerate installed Chromium-family browsers + policy targets
 *   - policy.ts — write/remove the force-install policy for the current OS
 */

/** Chromium-family browsers we can force-install into. */
export type BrowserFamily = "chrome" | "chromium" | "edge" | "brave";

export const BROWSER_FAMILIES: readonly BrowserFamily[] = ["chrome", "chromium", "edge", "brave"];

/** A browser discovered on this machine. */
export interface DetectedBrowser {
	family: BrowserFamily;
	/** Human display name, e.g. "Google Chrome". */
	name: string;
	/** Absolute path to the launchable executable. */
	executablePath: string;
}

/** Signed-CRX artifacts produced by {@link file://./crx.ts}. */
export interface CrxArtifacts {
	/** Absolute path to the packed, signed `.crx`. */
	crxPath: string;
	/** Absolute path to the Omaha `update.xml` referencing the crx via `file://`. */
	updateManifestPath: string;
	/** 32-char (a–p) extension id derived from the signing key. */
	extensionId: string;
	/** DER SubjectPublicKeyInfo, base64 — the value for manifest `"key"`. */
	publicKeyBase64: string;
}

/** Outcome of a policy install/removal attempt for one browser family. */
export interface PolicyResult {
	family: BrowserFamily;
	/** True when the policy was actually written/removed. */
	applied: boolean;
	/** Human-readable location touched (registry path, plist domain, or file). */
	location: string;
	/** Present when not applied: why, and what the user should do instead. */
	message?: string;
	/**
	 * Present when not applied and a manual fallback exists: the verbatim
	 * command(s) the user can run themselves to write the policy. Presentation
	 * layers print this block; when absent there is nothing to print.
	 */
	manualCommand?: string;
}

/** Result of one external command invocation. */
export interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Injectable command invoker — the seam policy.ts uses to reach `reg`/`defaults`. */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/** Options common to policy install/remove. */
export interface PolicyOptions {
	family: BrowserFamily;
	extensionId: string;
	/** Absolute path to `update.xml` (install only). */
	updateManifestPath?: string;
	/**
	 * Prefer the system/machine-wide policy store (needs elevation) over the
	 * per-user store. Default false → per-user where the OS supports it
	 * (Windows HKCU, macOS user defaults); Linux is always system-wide.
	 */
	system?: boolean;
	/**
	 * When passwordless `sudo -n` fails, retry the elevation with an interactive
	 * `sudo` that inherits the controlling terminal so the user can type their
	 * password. Requires a TTY (the `loom webbridge` CLI); the `/webbridge`
	 * slash command leaves this off and instructs instead. Linux only.
	 */
	interactiveSudo?: boolean;
	/**
	 * Override the external-command invoker. Defaults to `execFile`; tests pass
	 * a stub so registry/`defaults` behaviour can be exercised off-platform.
	 */
	exec?: CommandRunner;
}
