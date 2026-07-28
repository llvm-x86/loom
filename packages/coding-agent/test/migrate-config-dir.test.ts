import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";
import { getConfigDirs } from "../src/config";
import { migrateLegacyConfigDir } from "../src/config/migrate-config-dir";

const ENV_KEYS = ["LOOM_CONFIG_DIR", "OMP_CONFIG_DIR", "PI_CONFIG_DIR"] as const;

let home: string;
const originals = new Map<string, string | undefined>();

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "loom-config-migrate-"));
	for (const key of ENV_KEYS) {
		originals.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const [key, value] of originals) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	originals.clear();
	fs.rmSync(home, { recursive: true, force: true });
});

function writeFileAt(...segments: string[]): void {
	const filePath = path.join(...segments);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "x");
}

describe("legacy config dir migration", () => {
	it("renames the legacy root wholesale when the destination is absent", () => {
		writeFileAt(home, LEGACY_CONFIG_DIR_NAME, "config.yml");
		writeFileAt(home, LEGACY_CONFIG_DIR_NAME, "profiles", "work", "agent", "agent.db");

		expect(migrateLegacyConfigDir({ home })).toBe("renamed");

		expect(fs.existsSync(path.join(home, LEGACY_CONFIG_DIR_NAME))).toBe(false);
		expect(fs.existsSync(path.join(home, CONFIG_DIR_NAME, "config.yml"))).toBe(true);
		expect(fs.existsSync(path.join(home, CONFIG_DIR_NAME, "profiles", "work", "agent", "agent.db"))).toBe(true);
	});

	it("is a no-op when there is no legacy root", () => {
		expect(migrateLegacyConfigDir({ home })).toBe("skipped");
		expect(fs.existsSync(path.join(home, CONFIG_DIR_NAME))).toBe(false);
	});

	it("merges non-conflicting entries, keeps conflicts, and removes an emptied source", () => {
		writeFileAt(home, LEGACY_CONFIG_DIR_NAME, "commands", "old.md");
		writeFileAt(home, CONFIG_DIR_NAME, "config.yml");

		expect(migrateLegacyConfigDir({ home })).toBe("merged");

		expect(fs.existsSync(path.join(home, CONFIG_DIR_NAME, "commands", "old.md"))).toBe(true);
		expect(fs.existsSync(path.join(home, LEGACY_CONFIG_DIR_NAME))).toBe(false);
	});

	it("leaves conflicting entries in a non-empty source untouched", () => {
		writeFileAt(home, LEGACY_CONFIG_DIR_NAME, "config.yml");
		writeFileAt(home, LEGACY_CONFIG_DIR_NAME, "commands", "old.md");
		fs.writeFileSync(path.join(home, LEGACY_CONFIG_DIR_NAME, "config.yml"), "legacy");
		fs.mkdirSync(path.join(home, CONFIG_DIR_NAME), { recursive: true });
		fs.writeFileSync(path.join(home, CONFIG_DIR_NAME, "config.yml"), "current");

		expect(migrateLegacyConfigDir({ home })).toBe("merged");

		expect(fs.readFileSync(path.join(home, CONFIG_DIR_NAME, "config.yml"), "utf8")).toBe("current");
		expect(fs.readFileSync(path.join(home, LEGACY_CONFIG_DIR_NAME, "config.yml"), "utf8")).toBe("legacy");
		expect(fs.existsSync(path.join(home, CONFIG_DIR_NAME, "commands", "old.md"))).toBe(true);
		expect(fs.existsSync(path.join(home, LEGACY_CONFIG_DIR_NAME))).toBe(true);
	});

	it("skips migration when a legacy config-dir override pins the root", () => {
		process.env.PI_CONFIG_DIR = ".pinned";
		writeFileAt(home, LEGACY_CONFIG_DIR_NAME, "config.yml");

		expect(migrateLegacyConfigDir({ home })).toBe("skipped");
		expect(fs.existsSync(path.join(home, LEGACY_CONFIG_DIR_NAME, "config.yml"))).toBe(true);
	});

	it("honors a canonical LOOM_CONFIG_DIR destination", () => {
		process.env.LOOM_CONFIG_DIR = ".loom-custom";
		writeFileAt(home, LEGACY_CONFIG_DIR_NAME, "config.yml");

		expect(migrateLegacyConfigDir({ home })).toBe("renamed");
		expect(fs.existsSync(path.join(home, ".loom-custom", "config.yml"))).toBe(true);
	});

	it("warns and continues when the move fails", () => {
		writeFileAt(home, LEGACY_CONFIG_DIR_NAME, "config.yml");
		// A regular file at the destination path makes both rename and merge fail.
		fs.writeFileSync(path.join(home, CONFIG_DIR_NAME), "not a directory");
		const warnings: string[] = [];

		expect(migrateLegacyConfigDir({ home, warn: message => warnings.push(message) })).toBe("failed");

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toContain("omp");
		expect(fs.existsSync(path.join(home, LEGACY_CONFIG_DIR_NAME, "config.yml"))).toBe(true);
	});
});

describe("project config dir priority", () => {
	it("ranks the canonical project dir above the legacy one", () => {
		const cwd = path.join(home, "project");
		fs.mkdirSync(path.join(cwd, CONFIG_DIR_NAME, "commands"), { recursive: true });
		fs.mkdirSync(path.join(cwd, LEGACY_CONFIG_DIR_NAME, "commands"), { recursive: true });

		const sources = getConfigDirs("commands", { user: false, cwd, existingOnly: true }).map(e => e.source);

		expect(sources).toEqual([CONFIG_DIR_NAME, LEGACY_CONFIG_DIR_NAME]);
	});
});
