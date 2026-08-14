import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/compaction-controller";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { CompactionLiveReporter } from "@oh-my-pi/pi-coding-agent/session/context/compaction/live-reporter";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";

const STALL_NOTICE_SNIPPET = "Compaction still running";

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

function createContext(): {
	ctx: InteractiveModeContext;
	root: () => Component | undefined;
	statusChildren: () => Component[];
} {
	// A real Container, not a single-slot fake: `addChild` appends, so a surface
	// re-mounted per progress tick shows up as duplicate children rather than
	// silently overwriting one slot.
	const statusContainer = new Container();
	const ctx = {
		isInitialized: true,
		focusedAgentId: undefined,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		settings,
		viewSession: { isStreaming: false },
		statusContainer,
		loadingAnimation: undefined,
		statusLine: { invalidate: vi.fn() },
		lastAssistantUsage: undefined,
		flushCompactionQueue: vi.fn(async () => {}),
		rebuildChatFromMessages: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		renderInitialMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		noteDisplayableThinkingContent: () => false,
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			terminal: { setProgress: vi.fn() },
		},
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		root: () => statusContainer.children[0],
		statusChildren: () => statusContainer.children,
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
}

describe("Compaction surface lifecycle", () => {
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

	it("auto-shake start→end leaves no live surface and no stall notice", async () => {
		const { ctx, root } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "shake",
		});
		expect(root()).toBeDefined();

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "shake",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});
		await flushMicrotasks();

		expect(root()).toBeUndefined();
		vi.advanceTimersByTime(20_000);
		expect(collectText(root() ?? new Text("", 1, 0)).join("\n")).not.toContain(STALL_NOTICE_SNIPPET);
	});

	it("early-skip auto compaction without compaction_live_start leaves no live surface", async () => {
		const { ctx, root } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "context-full",
		});
		expect(root()).toBeDefined();

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});
		await flushMicrotasks();

		expect(root()).toBeUndefined();
	});

	it("manual compaction_preparing shows a surface before compaction_live_start", async () => {
		const { ctx, root } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "compaction_preparing", trigger: "manual" });
		const preparingText = collectText(root()!).join("\n");
		expect(preparingText).toContain("preparing");
		expect(preparingText).toContain("esc to cancel");

		await controller.handleEvent({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 2,
			tokensBefore: 50_000,
		});

		expect(collectText(root()!).join("\n")).toContain("Compacting");
	});

	it("overlapping auto-then-manual: auto end does not tear down manual surface", async () => {
		const { ctx, root } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "context-full",
		});
		expect(root()).toBeDefined();

		await controller.handleEvent({ type: "compaction_preparing", trigger: "manual" });
		expect(collectText(root()!).join("\n")).toContain("esc to cancel");

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});
		await flushMicrotasks();
		expect(root()).toBeDefined();

		await controller.handleEvent({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 2,
			tokensBefore: 50_000,
		});
		await controller.handleEvent({
			type: "compaction_live_progress",
			phase: "history_summary",
			messagesDone: 1,
			messagesTotal: 2,
		});
		expect(collectText(root()!).join("\n")).toContain("Compacting");

		await controller.handleEvent({
			type: "compaction_live_end",
			trigger: "manual",
			aborted: false,
			result: undefined,
		});
		await flushMicrotasks();
		expect(root()).toBeUndefined();
	});
});

describe("CompactionLiveReporter slot ownership", () => {
	it("displaced auto reporter stays silent while manual reporter receives updates and end", async () => {
		const emitted: Array<{ type: string; trigger?: string }> = [];
		const autoReporter = new CompactionLiveReporter({
			trigger: "auto",
			sideStreamFn: async () => ({ result: async () => ({ role: "assistant" }) }) as never,
			emit: async event => {
				emitted.push({ type: event.type, trigger: "trigger" in event ? event.trigger : undefined });
			},
		});
		const manualReporter = new CompactionLiveReporter({
			trigger: "manual",
			sideStreamFn: async () => ({ result: async () => ({ role: "assistant" }) }) as never,
			emit: async event => {
				emitted.push({ type: event.type, trigger: "trigger" in event ? event.trigger : undefined });
			},
		});

		autoReporter.start({
			preparation: {
				firstKeptEntryId: "k1",
				messagesToSummarize: [{ role: "user", content: "a", timestamp: 1 }],
				turnPrefixMessages: [],
				recentMessages: [],
				tokensBefore: 1000,
				isSplitTurn: false,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: {} as never,
			},
			phase: "preparing",
		});
		autoReporter.deactivate();

		manualReporter.start({
			preparation: {
				firstKeptEntryId: "k1",
				messagesToSummarize: [{ role: "user", content: "b", timestamp: 2 }],
				turnPrefixMessages: [],
				recentMessages: [],
				tokensBefore: 2000,
				isSplitTurn: false,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: {} as never,
			},
			phase: "preparing",
		});
		manualReporter.progress({ phase: "history_summary", messagesDone: 1, messagesTotal: 1 });
		await manualReporter.end({ aborted: false, result: undefined });
		await autoReporter.end({ aborted: false, result: undefined });

		expect(emitted.filter(e => e.type === "compaction_live_update")).toHaveLength(0);
		expect(emitted.filter(e => e.type === "compaction_live_progress")).toHaveLength(1);
		expect(emitted.filter(e => e.type === "compaction_live_end" && e.trigger === "manual")).toHaveLength(1);
		expect(emitted.filter(e => e.type === "compaction_live_end" && e.trigger === "auto")).toHaveLength(0);
	});
});

describe("CompactionController reconcile", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reconcileAutoCompactionEnd tears down a preparing-only surface", () => {
		const { ctx, root } = createContext();
		const controller = new CompactionController(ctx);
		controller.handleAutoCompactionStart({ type: "auto_compaction_start", reason: "threshold", action: "shake" });
		expect(controller.isSurfaceLive()).toBe(true);

		controller.reconcileAutoCompactionEnd();
		expect(controller.isSurfaceLive()).toBe(false);
		expect(root()).toBeUndefined();
	});
});
