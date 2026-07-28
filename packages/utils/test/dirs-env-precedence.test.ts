import { afterEach, describe, expect, it } from "bun:test";
import { CONFIG_DIR_NAME, getConfigDirName, resolveProfileEnv } from "@oh-my-pi/pi-utils/dirs";

const CONFIG_KEYS = ["LOOM_CONFIG_DIR", "OMP_CONFIG_DIR", "PI_CONFIG_DIR"] as const;

const originals = new Map<string, string | undefined>(CONFIG_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
	for (const [key, value] of originals) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

function setConfigEnv(values: Partial<Record<(typeof CONFIG_KEYS)[number], string>>): void {
	for (const key of CONFIG_KEYS) {
		const value = values[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

describe("config dir env precedence", () => {
	it("defaults to the canonical loom config dir", () => {
		setConfigEnv({});
		expect(CONFIG_DIR_NAME).toBe(".loom");
		expect(getConfigDirName()).toBe(".loom");
	});

	it("prefers LOOM_CONFIG_DIR over the legacy overrides", () => {
		setConfigEnv({ LOOM_CONFIG_DIR: ".loom-a", OMP_CONFIG_DIR: ".omp-b", PI_CONFIG_DIR: ".pi-c" });
		expect(getConfigDirName()).toBe(".loom-a");
	});

	it("falls back to OMP_CONFIG_DIR before PI_CONFIG_DIR", () => {
		setConfigEnv({ OMP_CONFIG_DIR: ".omp-b", PI_CONFIG_DIR: ".pi-c" });
		expect(getConfigDirName()).toBe(".omp-b");
	});

	it("falls back to PI_CONFIG_DIR when nothing else is set", () => {
		setConfigEnv({ PI_CONFIG_DIR: ".pi-c" });
		expect(getConfigDirName()).toBe(".pi-c");
	});
});

describe("profile env precedence", () => {
	it("prefers LOOM_PROFILE over the legacy variables", () => {
		expect(resolveProfileEnv("work", "old", "ancient")).toBe("work");
	});

	it("falls back to OMP_PROFILE, then PI_PROFILE", () => {
		expect(resolveProfileEnv(undefined, "old", "ancient")).toBe("old");
		expect(resolveProfileEnv(undefined, undefined, "ancient")).toBe("ancient");
	});

	it("treats an explicitly empty higher-priority variable as the default profile", () => {
		expect(resolveProfileEnv("", "old", "ancient")).toBeUndefined();
		expect(resolveProfileEnv(undefined, "", "ancient")).toBeUndefined();
	});

	it("throws on an invalid profile name", () => {
		expect(() => resolveProfileEnv("..", undefined, undefined)).toThrow();
	});
});
