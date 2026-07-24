import { describe, expect, it } from "bun:test";
import { appendModelRedirectNote } from "@oh-my-pi/pi-coding-agent/task/spawn-error-guidance";
import type { ModelRedirectNote } from "@oh-my-pi/pi-coding-agent/task/types";

const REDIRECT: ModelRedirectNote = {
	from: "cursor/composer-2.5-fast",
	to: "anthropic/claude-sonnet-5",
	blockedUntilMs: Date.UTC(2026, 6, 24, 14, 32, 0),
};

describe("appendModelRedirectNote", () => {
	it("leaves text untouched when no redirect happened", () => {
		expect(appendModelRedirectNote("done", undefined)).toBe("done");
	});

	it("names both models and when the parked provider frees up", () => {
		const text = appendModelRedirectNote("done", REDIRECT);
		expect(text.startsWith("done\n\n")).toBe(true);
		expect(text).toContain("`cursor/composer-2.5-fast` is quota-parked");
		expect(text).toContain("ran on `anthropic/claude-sonnet-5`");
		expect(text).toContain("~14:32Z");
	});

	it("is idempotent so a re-rendered result does not stack notes", () => {
		const once = appendModelRedirectNote("done", REDIRECT);
		expect(appendModelRedirectNote(once, REDIRECT)).toBe(once);
	});
});
