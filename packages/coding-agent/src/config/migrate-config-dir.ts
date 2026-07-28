import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirName, LEGACY_CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";

export interface MigrateConfigDirOptions {
	/** Home directory to resolve both roots against. Defaults to `os.homedir()`. */
	home?: string;
	/** Warning sink. Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

export type MigrateConfigDirOutcome = "skipped" | "renamed" | "merged" | "failed";

/**
 * Move a pre-rename `~/.omp` config directory to the current config root.
 *
 * Runs on every CLI start and must stay near-instant: it renames the whole tree
 * when the destination is absent, and otherwise only walks the *top level* of
 * the source, moving entries that do not collide. Colliding entries stay in the
 * source (the destination always wins), and the source directory is removed
 * only once it is empty.
 *
 * Silent by design — the old name is never mentioned to the user. Any failure
 * is reported as a single warning and startup continues on the current root.
 *
 * Skipped entirely when a legacy config-dir env override pins the config root
 * (the user explicitly chose that layout) or when source and destination
 * resolve to the same directory.
 */
export function migrateLegacyConfigDir(options: MigrateConfigDirOptions = {}): MigrateConfigDirOutcome {
	const home = options.home ?? os.homedir();
	const warn = options.warn ?? console.warn;
	if (process.env.OMP_CONFIG_DIR || process.env.PI_CONFIG_DIR) return "skipped";

	const configDirName = getConfigDirName();
	const source = path.join(home, LEGACY_CONFIG_DIR_NAME);
	const destination = path.join(home, configDirName);
	if (path.resolve(source) === path.resolve(destination)) return "skipped";

	try {
		const sourceEntries = readDirEntries(source);
		if (sourceEntries === undefined) return "skipped";

		if (!fs.existsSync(destination)) {
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			fs.renameSync(source, destination);
			return "renamed";
		}

		for (const entry of sourceEntries) {
			const target = path.join(destination, entry);
			if (fs.existsSync(target)) continue;
			fs.renameSync(path.join(source, entry), target);
		}
		if (readDirEntries(source)?.length === 0) {
			fs.rmdirSync(source);
		}
		return "merged";
	} catch (error) {
		// Only the error code is reported: the raw message embeds the pre-rename
		// path, and the old name must never surface to the user.
		const code = error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.name) : "unknown error";
		warn(`Could not finish updating the ${configDirName} configuration directory (${code}); continuing.`);
		return "failed";
	}
}

/** Top-level entry names of `dir`, or `undefined` when it is not a readable directory. */
function readDirEntries(dir: string): string[] | undefined {
	try {
		return fs.readdirSync(dir);
	} catch {
		return undefined;
	}
}
