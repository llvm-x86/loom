import { describe, expect, it } from "bun:test";
import { normalizeShellTimeoutSeconds } from "@oh-my-pi/pi-ai";
import { clampTimeout } from "../src/tools/tool-timeouts";

describe("bash timeout normalization", () => {
	it("treats 15000 as 15 seconds before clamping", () => {
		const requested = normalizeShellTimeoutSeconds(15_000) ?? 15_000;
		expect(clampTimeout("bash", requested)).toBe(15);
	});

	it("does not clamp 15-second requests to the one-hour ceiling", () => {
		const requested = normalizeShellTimeoutSeconds(15) ?? 15;
		expect(clampTimeout("bash", requested)).toBe(15);
	});
});
