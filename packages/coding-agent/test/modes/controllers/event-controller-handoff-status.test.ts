import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

/**
 * Regression coverage for the auto-handoff completion status: `auto_compaction_end`
 * previously dropped `HandoffResult.savedPath` before it reached the UI, so
 * "Auto-handoff completed" never told the operator where the document went even
 * when `compaction.handoffSaveToDisk` was on. The fix threads `handoffSavedPath`
 * through the event and appends it to the status line when present.
 */
function createContext() {
	const ctx = {
		isInitialized: true,
		settings: { get: () => false },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		flushPendingCommandOutput: vi.fn(),
		pendingTools: new Map<string, unknown>(),
		hideThinkingBlock: false,
		setWorkingMessage: vi.fn(),
		clearPinnedError: vi.fn(),
		loadingAnimation: undefined,
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		lastAssistantUsage: undefined,
		statusContainer: {
			children: [],
			clear: vi.fn(),
			disposeChildren: vi.fn(),
			addChild: vi.fn(),
			removeChild: vi.fn(),
		},
		chatContainer: { removeChild: vi.fn(), clear: vi.fn() },
		flushPendingModelSwitch: vi.fn(async () => {}),
		flushCompactionQueue: vi.fn(async () => {}),
		rebuildChatFromMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		clearTransientSessionUi: vi.fn(),
		renderInitialMessages: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => "test-session" },
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		viewSession: { isCompacting: false, getLastAssistantMessage: () => undefined, isStreaming: false },
		session: { isStreaming: false, getToolByName: () => undefined },
	} as unknown as InteractiveModeContext;
	return { ctx };
}

describe("EventController auto-handoff completion status", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("reports the saved path when the handoff document was written to disk", async () => {
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "handoff",
			result: undefined,
			aborted: false,
			willRetry: false,
			handoffSavedPath: "/tmp/session/handoff-2026-08-14T00-00-00-000Z.md",
		} as unknown as AgentSessionEvent);

		expect(ctx.showStatus).toHaveBeenCalledWith(
			"Auto-handoff completed. Handoff document saved to: /tmp/session/handoff-2026-08-14T00-00-00-000Z.md",
		);
	});

	it("falls back to the plain message when the document was not saved to disk", async () => {
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "auto_compaction_end",
			action: "handoff",
			result: undefined,
			aborted: false,
			willRetry: false,
		} as unknown as AgentSessionEvent);

		expect(ctx.showStatus).toHaveBeenCalledWith("Auto-handoff completed");
	});
});
