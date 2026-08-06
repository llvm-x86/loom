import { describe, expect, it } from "bun:test";
import {
	normalizeShellTimeoutSeconds,
	resolveCursorShellTimeoutSeconds,
} from "../src/providers/cursor-shell-timeout";

describe("normalizeShellTimeoutSeconds", () => {
	it("converts millisecond values above the bash ceiling", () => {
		expect(normalizeShellTimeoutSeconds(15_000)).toBe(15);
		expect(normalizeShellTimeoutSeconds(5_000)).toBe(5);
		expect(normalizeShellTimeoutSeconds(300_000)).toBe(300);
	});

	it("keeps second-scale values at or below the bash ceiling", () => {
		expect(normalizeShellTimeoutSeconds(15)).toBe(15);
		expect(normalizeShellTimeoutSeconds(300)).toBe(300);
		expect(normalizeShellTimeoutSeconds(3600)).toBe(3600);
	});

	it("returns undefined for missing or non-positive values", () => {
		expect(normalizeShellTimeoutSeconds(undefined)).toBeUndefined();
		expect(normalizeShellTimeoutSeconds(0)).toBeUndefined();
		expect(normalizeShellTimeoutSeconds(-1)).toBeUndefined();
	});
});

describe("resolveCursorShellTimeoutSeconds", () => {
	it("converts hard_timeout milliseconds to seconds", () => {
		expect(resolveCursorShellTimeoutSeconds({ timeout: 0, hardTimeout: 15_000 })).toBe(15);
	});

	it("converts large timeout values from milliseconds", () => {
		expect(resolveCursorShellTimeoutSeconds({ timeout: 15_000 })).toBe(15);
		expect(resolveCursorShellTimeoutSeconds({ timeout: 5_000 })).toBe(5);
		expect(resolveCursorShellTimeoutSeconds({ timeout: 300_000 })).toBe(300);
	});

	it("keeps small timeout values as seconds", () => {
		expect(resolveCursorShellTimeoutSeconds({ timeout: 15 })).toBe(15);
		expect(resolveCursorShellTimeoutSeconds({ timeout: 300 })).toBe(300);
		expect(resolveCursorShellTimeoutSeconds({ timeout: 3600 })).toBe(3600);
	});

	it("prefers hard_timeout over timeout", () => {
		expect(resolveCursorShellTimeoutSeconds({ timeout: 300, hardTimeout: 12_000 })).toBe(12);
	});

	it("returns undefined when no timeout is set", () => {
		expect(resolveCursorShellTimeoutSeconds({ timeout: 0 })).toBeUndefined();
		expect(resolveCursorShellTimeoutSeconds({ timeout: -1 })).toBeUndefined();
	});
});
