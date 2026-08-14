import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/compaction-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";

/** Exact stall-notice copy from CompactionController.#startStallTimer (minus theme wrappers). */
const STALL_NOTICE_SNIPPET = "Compaction still running";
const STALL_NOTICE_TAIL = "Press Esc to cancel.";

function isStallNoticeText(text: string): boolean {
	return text.includes(STALL_NOTICE_SNIPPET) && text.includes(STALL_NOTICE_TAIL);
}

function collectText(component: Component): string[] {
	const lines: string[] = [];
	if (component instanceof Text) {
		lines.push(component.getText());
	}
	const children = (component as { children?: Component[] }).children ?? [];
	for (const child of children) {
		lines.push(...collectText(child));
	}
	return lines;
}

function createContext(options: { showStatus?: (message: string, opts?: { dim?: boolean }) => void } = {}): {
	ctx: InteractiveModeContext;
	root: () => Component | undefined;
} {
	let mountedRoot: Component | undefined;
	const statusContainer = {
		disposeChildren: vi.fn(() => {
			mountedRoot = undefined;
		}),
		addChild: vi.fn((child: Component) => {
			mountedRoot = child;
		}),
	};
	const ctx = {
		isInitialized: true,
		focusedAgentId: undefined,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		settings: Settings,
		statusContainer,
		noteDisplayableThinkingContent: () => false,
		showStatus: options.showStatus ?? vi.fn(),
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	return { ctx, root: () => mountedRoot };
}

function getStallTimerId(setIntervalSpy: ReturnType<typeof vi.spyOn>): ReturnType<typeof setInterval> | undefined {
	return setIntervalSpy.mock.results.at(-1)?.value;
}

function expectStallTimerCleared(
	clearIntervalSpy: ReturnType<typeof vi.spyOn>,
	stallTimerId: ReturnType<typeof setInterval> | undefined,
): void {
	expect(stallTimerId).toBeDefined();
	expect(clearIntervalSpy.mock.calls.some((call: unknown[]) => call[0] === stallTimerId)).toBe(true);
}

function expectNoStallActivityAfter(requestRender: ReturnType<typeof vi.fn>, renderCountCheckpoint: number): void {
	vi.advanceTimersByTime(10_000);
	expect(requestRender.mock.calls.length).toBe(renderCountCheckpoint);
}

type StallNoticeObserver = {
	checkpoint: () => void;
	assertNoStallNoticeDuringAdvance: (advanceMs: number) => void;
	restore: () => void;
};

const STALL_NOTICE_SECONDS = 5;

function stallNoticeAdvanceMs(): number {
	return STALL_NOTICE_SECONDS * 1000 * 3;
}

function createStallNoticeObserver(
	ctx: InteractiveModeContext,
	root: () => Component | undefined,
): StallNoticeObserver {
	const retainedSurfaces: Component[] = [];
	const statusContainerTexts: string[] = [];
	const setTextCalls: string[] = [];
	const showStatusCalls: string[] = [];
	const renderTextsAfterCheckpoint: string[] = [];
	let setTextCheckpoint = 0;
	let showStatusCheckpoint = 0;
	let statusContainerCheckpoint = 0;
	let observingAfterCheckpoint = false;
	const surfaceTextAtCheckpoint = new Map<Component, string>();

	const originalSetText = Text.prototype.setText;
	Text.prototype.setText = function (this: Text, value: string) {
		setTextCalls.push(value);
		return originalSetText.call(this, value);
	};

	const originalAddChild = ctx.statusContainer!.addChild as (child: Component) => void;
	ctx.statusContainer!.addChild = vi.fn((child: Component) => {
		retainedSurfaces.push(child);
		originalAddChild(child);
		statusContainerTexts.push(collectText(child).join("\n"));
	});

	const originalShowStatus = ctx.showStatus as (message: string, opts?: { dim?: boolean }) => void;
	ctx.showStatus = vi.fn((message: string, opts?: { dim?: boolean }) => {
		showStatusCalls.push(message);
		originalShowStatus(message, opts);
	});

	const requestRender = ctx.ui.requestRender as ReturnType<typeof vi.fn>;
	let renderCheckpoint = 0;
	requestRender.mockImplementation(() => {
		if (!observingAfterCheckpoint) return;
		const mounted = root();
		if (mounted) {
			renderTextsAfterCheckpoint.push(collectText(mounted).join("\n"));
		}
	});

	const assertNoNewStallMaterial = (): void => {
		expect(requestRender.mock.calls.length).toBe(renderCheckpoint);
		for (const text of setTextCalls.slice(setTextCheckpoint)) {
			expect(isStallNoticeText(text)).toBe(false);
		}
		for (const text of showStatusCalls.slice(showStatusCheckpoint)) {
			expect(isStallNoticeText(text)).toBe(false);
		}
		for (const text of statusContainerTexts.slice(statusContainerCheckpoint)) {
			expect(isStallNoticeText(text)).toBe(false);
		}
		for (const text of renderTextsAfterCheckpoint) {
			expect(isStallNoticeText(text)).toBe(false);
		}
		const mounted = root();
		if (mounted) {
			expect(isStallNoticeText(collectText(mounted).join("\n"))).toBe(false);
		}
		for (const surface of retainedSurfaces) {
			const before = surfaceTextAtCheckpoint.get(surface) ?? "";
			const after = collectText(surface).join("\n");
			if (before !== after) {
				expect(isStallNoticeText(after)).toBe(false);
			}
		}
	};

	return {
		checkpoint: () => {
			setTextCheckpoint = setTextCalls.length;
			showStatusCheckpoint = showStatusCalls.length;
			statusContainerCheckpoint = statusContainerTexts.length;
			renderCheckpoint = requestRender.mock.calls.length;
			renderTextsAfterCheckpoint.length = 0;
			surfaceTextAtCheckpoint.clear();
			for (const surface of retainedSurfaces) {
				surfaceTextAtCheckpoint.set(surface, collectText(surface).join("\n"));
			}
			observingAfterCheckpoint = true;
		},
		assertNoStallNoticeDuringAdvance: (advanceMs: number) => {
			const stepMs = 1000;
			for (let advanced = 0; advanced < advanceMs; advanced += stepMs) {
				vi.advanceTimersByTime(stepMs);
				assertNoNewStallMaterial();
			}
		},
		restore: () => {
			Text.prototype.setText = originalSetText;
		},
	};
}

const sampleResult: CompactionResult = {
	summary: "summary",
	firstKeptEntryId: "entry-1",
	tokensBefore: 120_000,
};

describe("CompactionController", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.stallNoticeSeconds": 5,
				"display.smoothStreaming": false,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
	});

	it("advances progress and attributes the compaction model", () => {
		const { ctx, root } = createContext();
		const controller = new CompactionController(ctx);
		controller.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 3,
			tokensBefore: 120_000,
		});
		controller.handleProgress({
			type: "compaction_live_progress",
			phase: "history_summary",
			messagesDone: 1,
			messagesTotal: 3,
			detail: "2 messages",
		});
		controller.handleModel({
			type: "compaction_live_model",
			model: {
				id: "claude-sonnet-4-5",
				provider: "anthropic",
				api: "anthropic-messages",
				contextWindow: 200_000,
				input: ["text"],
			} as Model,

			thinkingLevel: ThinkingLevel.Medium,
		});

		const text = collectText(root()!).join("\n");
		expect(text).toContain("Summarizing history");
		expect(text).toContain("1/3");
		expect(text).toContain("anthropic/claude-sonnet-4-5:medium");
	});

	it("does not attribute a later run to an earlier compaction model", () => {
		const showStatus = vi.fn();
		const { ctx } = createContext({ showStatus });
		const controller = new CompactionController(ctx);
		controller.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 3,
			tokensBefore: 120_000,
		});
		controller.handleModel({
			type: "compaction_live_model",
			model: {
				id: "claude-sonnet-4-5",
				provider: "anthropic",
				api: "anthropic-messages",
				contextWindow: 200_000,
				input: ["text"],
			} as Model,
			thinkingLevel: ThinkingLevel.Medium,
		});
		controller.handleEnd({
			type: "compaction_live_end",
			trigger: "manual",
			aborted: false,
			result: sampleResult,
			modelLabel: "anthropic/claude-sonnet-4-5:medium",
		});
		showStatus.mockClear();

		controller.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "snapcompact",
			messagesTotal: 1,
			tokensBefore: 10_000,
		});
		controller.handleEnd({
			type: "compaction_live_end",
			trigger: "manual",
			aborted: false,
			result: { ...sampleResult, tokensBefore: 10_000 },
		});

		expect(showStatus).toHaveBeenCalledWith("Compacted 1 messages · was ~10k tokens", { dim: true });
	});

	it("shows a stall notice after the threshold and clears it on new progress", () => {
		const { ctx, root } = createContext();
		const controller = new CompactionController(ctx);
		controller.handleStart({
			type: "compaction_live_start",
			trigger: "auto",
			action: "context-full",
			reason: "threshold",
			phase: "preparing",
			messagesTotal: 2,
			tokensBefore: 90_000,
		});

		vi.advanceTimersByTime(6000);
		expect(collectText(root()!).join("\n")).toContain("still running");

		controller.handleProgress({
			type: "compaction_live_progress",
			phase: "history_summary",
			messagesDone: 1,
			messagesTotal: 2,
		});
		expect(collectText(root()!).join("\n")).not.toContain("still running");

		vi.advanceTimersByTime(6000);
		expect(collectText(root()!).join("\n")).toContain("still running");
	});

	it("does not emit a stall notice after completion", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { ctx, root } = createContext();
		const requestRender = ctx.ui.requestRender as ReturnType<typeof vi.fn>;
		const controller = new CompactionController(ctx);
		controller.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 4,
			tokensBefore: 150_000,
		});
		const stallTimerId = getStallTimerId(setIntervalSpy);
		vi.advanceTimersByTime(6000);
		expect(collectText(root()!).join("\n")).toContain("still running");

		clearIntervalSpy.mockClear();
		const renderCountBeforeEnd = requestRender.mock.calls.length;
		controller.handleEnd({
			type: "compaction_live_end",
			trigger: "manual",
			aborted: false,
			result: sampleResult,
			modelLabel: "anthropic/claude-sonnet-4-5:medium",
		});
		expectStallTimerCleared(clearIntervalSpy, stallTimerId);
		expectNoStallActivityAfter(requestRender, requestRender.mock.calls.length);
		expect(renderCountBeforeEnd).toBeLessThanOrEqual(requestRender.mock.calls.length);
	});

	it("cleans up timers on abort/end and shows a quiet success line", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const showStatus = vi.fn();
		const { ctx } = createContext({ showStatus });
		const requestRender = ctx.ui.requestRender as ReturnType<typeof vi.fn>;
		const controller = new CompactionController(ctx);
		controller.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 2,
			tokensBefore: 80_000,
		});
		const successRunTimerId = getStallTimerId(setIntervalSpy);
		clearIntervalSpy.mockClear();
		controller.handleEnd({
			type: "compaction_live_end",
			trigger: "manual",
			aborted: false,
			result: sampleResult,
			modelLabel: "anthropic/claude-sonnet-4-5:medium",
		});
		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("Compacted 2 messages"), { dim: true });
		expectStallTimerCleared(clearIntervalSpy, successRunTimerId);
		const rendersAfterSuccessEnd = requestRender.mock.calls.length;
		expectNoStallActivityAfter(requestRender, rendersAfterSuccessEnd);

		const abortCtx = createContext().ctx;
		const abortRequestRender = abortCtx.ui.requestRender as ReturnType<typeof vi.fn>;
		const controller2 = new CompactionController(abortCtx);
		controller2.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 1,
			tokensBefore: 10_000,
		});
		const abortRunTimerId = getStallTimerId(setIntervalSpy);
		clearIntervalSpy.mockClear();
		controller2.handleEnd({
			type: "compaction_live_end",
			trigger: "manual",
			aborted: true,
		});
		expectStallTimerCleared(clearIntervalSpy, abortRunTimerId);
		expectNoStallActivityAfter(abortRequestRender, abortRequestRender.mock.calls.length);

		const disposeCtx = createContext().ctx;
		const disposeRequestRender = disposeCtx.ui.requestRender as ReturnType<typeof vi.fn>;
		const disposeController = new CompactionController(disposeCtx);
		disposeController.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 1,
			tokensBefore: 10_000,
		});
		const disposeRunTimerId = getStallTimerId(setIntervalSpy);
		clearIntervalSpy.mockClear();
		disposeController.dispose();
		expectStallTimerCleared(clearIntervalSpy, disposeRunTimerId);
		expectNoStallActivityAfter(disposeRequestRender, disposeRequestRender.mock.calls.length);
	});

	describe("stall notice threshold resolution", () => {
		it("never arms the stall timer when the setting is 0", async () => {
			const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
			setIntervalSpy.mockClear();
			resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"compaction.stallNoticeSeconds": 0,
					"display.smoothStreaming": false,
				},
			});
			const { ctx, root } = createContext();
			const controller = new CompactionController(ctx);
			controller.handleStart({
				type: "compaction_live_start",
				trigger: "manual",
				phase: "preparing",
				messagesTotal: 2,
				tokensBefore: 90_000,
			});
			// Loader animation uses one interval; stall notice must not add another.
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(120_000);
			expect(collectText(root() ?? new Text("", 1, 0)).join("\n")).not.toContain(STALL_NOTICE_SNIPPET);
		});

		it("uses the default interval for NaN instead of arming a hot timer", async () => {
			const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
			setIntervalSpy.mockClear();
			resetSettingsForTest();
			await Settings.init({
				inMemory: true,
				overrides: {
					"compaction.stallNoticeSeconds": Number.NaN,
					"display.smoothStreaming": false,
				},
			});
			const { ctx, root } = createContext();
			const controller = new CompactionController(ctx);
			controller.handleStart({
				type: "compaction_live_start",
				trigger: "manual",
				phase: "preparing",
				messagesTotal: 2,
				tokensBefore: 90_000,
			});
			const stallTimerId = getStallTimerId(setIntervalSpy);
			expect(stallTimerId).toBeDefined();
			vi.advanceTimersByTime(29_999);
			expect(collectText(root()!).join("\n")).not.toContain(STALL_NOTICE_SNIPPET);
			vi.advanceTimersByTime(1);
			expect(collectText(root()!).join("\n")).toContain(STALL_NOTICE_SNIPPET);
		});
	});

	describe("stall notice operator visibility after terminal compaction states", () => {
		const startEvent = {
			type: "compaction_live_start" as const,
			trigger: "manual" as const,
			phase: "preparing" as const,
			messagesTotal: 2,
			tokensBefore: 80_000,
		};

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("does not surface stall notice text after a normal end", () => {
			const { ctx, root } = createContext();
			const observer = createStallNoticeObserver(ctx, root);
			const controller = new CompactionController(ctx);
			controller.handleStart(startEvent);
			vi.advanceTimersByTime(6000);
			expect(collectText(root()!).join("\n")).toContain(STALL_NOTICE_SNIPPET);

			controller.handleEnd({
				type: "compaction_live_end",
				trigger: "manual",
				aborted: false,
				result: sampleResult,
				modelLabel: "anthropic/claude-sonnet-4-5:medium",
			});
			observer.checkpoint();
			observer.assertNoStallNoticeDuringAdvance(stallNoticeAdvanceMs());
			observer.restore();
		});

		it("does not surface stall notice text after abort", () => {
			const { ctx, root } = createContext();
			const observer = createStallNoticeObserver(ctx, root);
			const controller = new CompactionController(ctx);
			controller.handleStart(startEvent);
			vi.advanceTimersByTime(6000);
			expect(collectText(root()!).join("\n")).toContain(STALL_NOTICE_SNIPPET);

			controller.handleEnd({
				type: "compaction_live_end",
				trigger: "manual",
				aborted: true,
			});
			observer.checkpoint();
			observer.assertNoStallNoticeDuringAdvance(stallNoticeAdvanceMs());
			observer.restore();
		});

		it("does not surface stall notice text after dispose mid-compaction", () => {
			const { ctx, root } = createContext();
			const observer = createStallNoticeObserver(ctx, root);
			const controller = new CompactionController(ctx);
			controller.handleStart(startEvent);
			vi.advanceTimersByTime(6000);
			expect(collectText(root()!).join("\n")).toContain(STALL_NOTICE_SNIPPET);

			controller.dispose();
			observer.checkpoint();
			observer.assertNoStallNoticeDuringAdvance(stallNoticeAdvanceMs());
			observer.restore();
		});
	});
});
