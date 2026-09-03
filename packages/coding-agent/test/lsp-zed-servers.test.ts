import { describe, expect, test } from "bun:test";
import { dropServersShadowedByZed } from "../src/lsp/config";
import type { ServerConfig } from "../src/lsp/types";
import { zedLanguageServerOverrides } from "../src/lsp/zed-servers";

function server(fileTypes: string[], isLinter = false): ServerConfig {
	return { command: "x", args: [], fileTypes, rootMarkers: [], isLinter } as ServerConfig;
}

describe("dropServersShadowedByZed", () => {
	test("Zed's primary server replaces loom's default for the same file types", () => {
		const servers = {
			basedpyright: server([".py"]),
			pyright: server([".py"]),
			gopls: server([".go"]),
		};
		dropServersShadowedByZed(servers, ["basedpyright"]);
		expect(Object.keys(servers).sort()).toEqual(["basedpyright", "gopls"]);
	});

	test("linters stack instead of being shadowed", () => {
		const servers = { basedpyright: server([".py"]), ruff: server([".py"], true) };
		dropServersShadowedByZed(servers, ["basedpyright", "ruff"]);
		expect(Object.keys(servers).sort()).toEqual(["basedpyright", "ruff"]);
	});

	test("a Zed linter alone shadows nothing", () => {
		const servers = { pyright: server([".py"]), ruff: server([".py"], true) };
		dropServersShadowedByZed(servers, ["ruff"]);
		expect(Object.keys(servers).sort()).toEqual(["pyright", "ruff"]);
	});

	test("unknown Zed server names are ignored", () => {
		const servers = { pyright: server([".py"]) };
		dropServersShadowedByZed(servers, ["some-zed-only-server"]);
		expect(Object.keys(servers)).toEqual(["pyright"]);
	});
});

describe("zedLanguageServerOverrides", () => {
	test("discovers nothing outside a Zed terminal", () => {
		const previous = { term: Bun.env.ZED_TERM, program: Bun.env.TERM_PROGRAM };
		delete Bun.env.ZED_TERM;
		delete Bun.env.TERM_PROGRAM;
		try {
			expect(zedLanguageServerOverrides()).toEqual({});
		} finally {
			if (previous.term !== undefined) Bun.env.ZED_TERM = previous.term;
			if (previous.program !== undefined) Bun.env.TERM_PROGRAM = previous.program;
		}
	});
});
