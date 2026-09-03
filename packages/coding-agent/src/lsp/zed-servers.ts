/**
 * Borrow the language servers of the Zed editor that owns this terminal.
 *
 * Zed installs its own server binaries under `<data-dir>/zed/languages/<name>/…`
 * and spawns them as its children — they are not on `$PATH`, so loom would
 * otherwise miss them entirely (or resolve a different binary) and report a
 * different diagnostic set than the editor on screen. `@zed-diagnostics` promises
 * parity with Zed's diagnostics panel, and parity starts with running the SAME
 * servers.
 *
 * Discovery is empirical: walk the process table and take the exact argv of any
 * live process whose command line points into Zed's `languages/` tree. That
 * needs no per-server knowledge (no guessing "basedpyright means
 * `node …/langserver.index.js --stdio`") and stays correct across Zed upgrades,
 * because the argv IS what Zed decided to run. The directory name doubles as the
 * server name, which is the same key loom's own `defaults.json` uses
 * (`basedpyright`, `ruff`, `rust-analyzer`, `gopls`, …), so an override merges
 * onto the matching entry and inherits its `fileTypes`/`rootMarkers`. A server
 * loom does not know by name is skipped — there is nothing to attach it to.
 *
 * Servers of OTHER Zed windows are picked up too. That is intentional and
 * harmless: `loadConfig` still filters every server by this project's root
 * markers, so a `rust-analyzer` from another window is only ever used for a
 * project that actually has a `Cargo.toml`.
 *
 * ponytail: Linux-only (reads `/proc/<pid>/cmdline` for exact, space-safe
 * argv). On macOS/Windows discovery returns nothing and loom falls back to
 * `$PATH` servers; wire up `ps -ww -o command=` parsing there if it matters.
 */
import * as fs from "node:fs";

/** Path segment identifying Zed's bundled language-server tree. */
const ZED_LANGUAGES_SEGMENT = "/zed/languages/";

/** Command + argv override for one server, keyed by Zed's directory name. */
export interface ZedServerOverride {
	command: string;
	args: string[];
}

/** Re-scan at most this often; Zed starts servers lazily as buffers open. */
const CACHE_TTL_MS = 30_000;

let cache: { at: number; overrides: Record<string, ZedServerOverride> } | undefined;

/**
 * Server name from an argv, or `undefined` when the process is not one of
 * Zed's language servers. The name is the directory directly under
 * `languages/`; the interpreter (`node`) may be `argv[0]` with the Zed path in
 * a later argument, so every argument is inspected.
 */
function zedServerName(argv: readonly string[]): string | undefined {
	for (const arg of argv) {
		const at = arg.indexOf(ZED_LANGUAGES_SEGMENT);
		if (at < 0) continue;
		const name = arg.slice(at + ZED_LANGUAGES_SEGMENT.length).split("/")[0];
		if (name) return name;
	}
	return undefined;
}

/**
 * Language-server overrides for the language servers Zed is running right now,
 * keyed by server name. Empty outside a Zed terminal, off Linux, or when Zed
 * has not started any server yet.
 */
export function zedLanguageServerOverrides(): Record<string, ZedServerOverride> {
	if (Bun.env.ZED_TERM !== "true" && Bun.env.TERM_PROGRAM?.toLowerCase() !== "zed") return {};
	if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.overrides;

	const overrides: Record<string, ZedServerOverride> = {};
	let pids: string[];
	try {
		pids = fs.readdirSync("/proc");
	} catch {
		cache = { at: Date.now(), overrides };
		return overrides;
	}

	for (const pid of pids) {
		if (!/^\d+$/.test(pid)) continue;
		let raw: string;
		try {
			raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
		} catch {
			continue; // process exited, or not ours to read
		}
		const argv = raw.split("\0").filter(arg => arg.length > 0);
		if (argv.length === 0) continue;
		const name = zedServerName(argv);
		if (!name || overrides[name]) continue;
		overrides[name] = { command: argv[0] as string, args: argv.slice(1) };
	}

	cache = { at: Date.now(), overrides };
	return overrides;
}
