import { describe, expect, it } from "bun:test";
import {
	COMPACTION_IDLE_TIMEOUT_SECONDS_DEFAULT,
	COMPACTION_STALL_NOTICE_SECONDS_DEFAULT,
	RECAP_IDLE_SECONDS_DEFAULT,
	resolveCompactionIdleTimeoutSeconds,
	resolveCompactionStallNoticeSeconds,
	resolveRecapIdleSeconds,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";

describe("resolveCompactionStallNoticeSeconds", () => {
	it("returns 0 when disabled", () => {
		expect(resolveCompactionStallNoticeSeconds(0)).toBe(0);
	});

	it("falls back to the default for NaN and non-numeric values", () => {
		expect(resolveCompactionStallNoticeSeconds(Number.NaN)).toBe(COMPACTION_STALL_NOTICE_SECONDS_DEFAULT);
		expect(resolveCompactionStallNoticeSeconds("not-a-number")).toBe(COMPACTION_STALL_NOTICE_SECONDS_DEFAULT);
	});
});

describe("resolveCompactionIdleTimeoutSeconds", () => {
	it("falls back to the default for NaN and non-numeric values", () => {
		expect(resolveCompactionIdleTimeoutSeconds(Number.NaN)).toBe(COMPACTION_IDLE_TIMEOUT_SECONDS_DEFAULT);
		expect(resolveCompactionIdleTimeoutSeconds(undefined)).toBe(COMPACTION_IDLE_TIMEOUT_SECONDS_DEFAULT);
	});
});

describe("resolveRecapIdleSeconds", () => {
	it("falls back to the default for NaN and non-numeric values", () => {
		expect(resolveRecapIdleSeconds(Number.NaN)).toBe(RECAP_IDLE_SECONDS_DEFAULT);
		expect(resolveRecapIdleSeconds("not-a-number")).toBe(RECAP_IDLE_SECONDS_DEFAULT);
	});
});
