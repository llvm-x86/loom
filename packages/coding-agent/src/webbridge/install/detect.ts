/**
 * Enumerate installed Chromium-family browsers on the current OS.
 *
 * Candidate paths mirror `systemChromiumCandidates()` in
 * `src/tools/browser/launch.ts`, extended per browser family (chrome,
 * chromium, edge, brave) and per platform (darwin, linux, win32).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { BrowserFamily, DetectedBrowser } from "./types";
import { BROWSER_FAMILIES } from "./types";

const FAMILY_DISPLAY_NAMES: Record<BrowserFamily, string> = {
	chrome: "Google Chrome",
	chromium: "Chromium",
	edge: "Microsoft Edge",
	brave: "Brave",
};

export function familyDisplayName(family: BrowserFamily): string {
	return FAMILY_DISPLAY_NAMES[family];
}

/** `.app`-relative executable paths, searched under /Applications and ~/Applications. */
const DARWIN_APPS: Record<BrowserFamily, readonly string[]> = {
	chrome: [
		"Google Chrome.app/Contents/MacOS/Google Chrome",
		"Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
		"Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
		"Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	],
	chromium: ["Chromium.app/Contents/MacOS/Chromium"],
	edge: ["Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
	brave: ["Brave Browser.app/Contents/MacOS/Brave Browser"],
};

/** Executable names resolved through `$which` (PATH lookup) on Linux. */
const LINUX_WHICH_NAMES: Record<BrowserFamily, readonly string[]> = {
	chrome: ["google-chrome-stable", "google-chrome"],
	chromium: ["chromium", "chromium-browser"],
	edge: ["microsoft-edge", "microsoft-edge-stable"],
	brave: ["brave-browser", "brave"],
};

/** Root-relative executable paths, searched under ProgramFiles, ProgramFiles(x86), and LOCALAPPDATA. */
const WIN32_RELPATHS: Record<BrowserFamily, readonly string[]> = {
	chrome: ["Google\\Chrome\\Application\\chrome.exe"],
	chromium: ["Chromium\\Application\\chrome.exe"],
	edge: ["Microsoft\\Edge\\Application\\msedge.exe"],
	brave: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
};

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		return st.isFile();
	} catch {
		return false;
	}
}

/** Absolute fallback paths on Linux (system packages, snap, flatpak, NixOS). */
function linuxAbsolutePaths(family: BrowserFamily, home: string): readonly string[] {
	switch (family) {
		case "chrome":
			return [
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
			];
		case "chromium":
			return [
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
				path.join(home, ".nix-profile/bin/chromium"),
				"/run/current-system/sw/bin/chromium",
			];
		case "edge":
			return ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"];
		case "brave":
			return ["/usr/bin/brave-browser", "/usr/bin/brave"];
	}
}

/** All candidate executable paths for one family on the current platform, in priority order. */
function familyCandidates(family: BrowserFamily): string[] {
	const home = os.homedir();
	const candidates: string[] = [];
	switch (process.platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				for (const app of DARWIN_APPS[family]) {
					candidates.push(path.join(root, app));
				}
			}
			break;
		}
		case "linux": {
			for (const name of LINUX_WHICH_NAMES[family]) {
				const found = $which(name);
				if (found) candidates.push(found);
			}
			candidates.push(...linuxAbsolutePaths(family, home));
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
			for (const root of [programFiles, programFilesX86, localAppData]) {
				for (const rel of WIN32_RELPATHS[family]) {
					candidates.push(path.join(root, rel));
				}
			}
			break;
		}
	}
	return candidates;
}

/**
 * Enumerate every installed Chromium-family browser on this OS, de-duplicated
 * by executable path. Order follows BROWSER_FAMILIES, then candidate priority.
 */
export function detectBrowsers(): DetectedBrowser[] {
	const seen = new Set<string>();
	const browsers: DetectedBrowser[] = [];
	for (const family of BROWSER_FAMILIES) {
		for (const candidate of familyCandidates(family)) {
			if (seen.has(candidate)) continue;
			if (!isExecutableFile(candidate)) continue;
			seen.add(candidate);
			browsers.push({ family, name: familyDisplayName(family), executablePath: candidate });
		}
	}
	return browsers;
}
