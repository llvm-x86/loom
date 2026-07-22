/**
 * Contracts: `sessionBootstrap` config → system-prompt injection.
 *
 * 1. `Settings.getSessionBootstrap()` returns `[]` when unset.
 * 2. Setting the key round-trips through the accessor.
 * 3. `loadSessionBootstrapBlock` reads existing files, skips missing ones
 *    with a warning, and returns `null` for an empty path list (proves the
 *    feature is a total no-op when unset).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionBootstrapBlock } from "@oh-my-pi/pi-coding-agent/config/session-bootstrap";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("sessionBootstrap", () => {
	it("getSessionBootstrap returns [] when unset", () => {
		const settings = Settings.isolated({});
		expect(settings.getSessionBootstrap()).toEqual([]);
	});

	it("getSessionBootstrap round-trips a configured list", () => {
		const settings = Settings.isolated({ sessionBootstrap: ["/tmp/a.md", "/tmp/b.md"] });
		expect(settings.getSessionBootstrap()).toEqual(["/tmp/a.md", "/tmp/b.md"]);
	});

	it("getSessionBootstrap drops non-string entries with a warning", () => {
		const settings = Settings.isolated({ sessionBootstrap: ["/tmp/a.md", 42, null] });
		expect(settings.getSessionBootstrap()).toEqual(["/tmp/a.md"]);
	});

	describe("loadSessionBootstrapBlock", () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "session-bootstrap-"));
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		it("returns null for an empty path list (no-op when unset)", async () => {
			const block = await loadSessionBootstrapBlock([]);
			expect(block).toBeNull();
		});

		it("injects file contents for an existing file", async () => {
			const filePath = join(dir, "briefing.md");
			writeFileSync(filePath, "Environment: staging\n");

			const block = await loadSessionBootstrapBlock([filePath]);

			expect(block).not.toBeNull();
			expect(block).toContain("## Session bootstrap context");
			expect(block).toContain(`<file path="${filePath}">`);
			expect(block).toContain("Environment: staging");
			expect(block).toContain("</file>");
		});

		it("skips a missing file with a warning and continues with the rest", async () => {
			const existingPath = join(dir, "exists.md");
			writeFileSync(existingPath, "present\n");
			const missingPath = join(dir, "does-not-exist.md");
			expect(existsSync(missingPath)).toBe(false);

			const errorSpy = spyOn(console, "error").mockImplementation(() => {});
			try {
				const block = await loadSessionBootstrapBlock([missingPath, existingPath]);

				expect(block).not.toBeNull();
				expect(block).toContain("present");
				expect(block).not.toContain(missingPath);
				expect(errorSpy).toHaveBeenCalledTimes(1);
				expect(errorSpy.mock.calls[0]?.[0]).toContain("[sessionBootstrap] skipped");
				expect(errorSpy.mock.calls[0]?.[0]).toContain(missingPath);
			} finally {
				errorSpy.mockRestore();
			}
		});

		it("returns null when every configured file is missing", async () => {
			const missingPath = join(dir, "gone.md");
			const errorSpy = spyOn(console, "error").mockImplementation(() => {});
			try {
				const block = await loadSessionBootstrapBlock([missingPath]);
				expect(block).toBeNull();
			} finally {
				errorSpy.mockRestore();
			}
		});
	});
});
