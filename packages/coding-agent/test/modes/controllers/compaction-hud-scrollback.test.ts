import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/compaction-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, type NativeScrollbackLiveRegion, Text, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

/**
 * Operator transcript this guards: a live todo HUD sits above compaction
 * status. TUI "topmost seam wins", so the todo HUD's unpinned live region
 * used to own the pin bit. Each compaction progress/spinner paint then froze
 * the previous "Auto context-full maintenance…" frame into native scrollback.
 * The Title I / summary paragraphs under those frames were the compaction
 * model's streamed output, not a second product surface.
 */
class AnchoredHud extends Container implements NativeScrollbackLiveRegion {
	#pinned = false;

	setNativeScrollbackPinned(pinned: boolean): void {
		this.#pinned = pinned;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		if (this.#pinned) return 0;
		return this.children.length > 0 ? 0 : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return this.#pinned;
	}
}

class HistoryBlock extends Container {
	constructor(rows: number) {
		super();
		for (let i = 0; i < rows; i++) {
			this.addChild(new Text(`hist-${String(i).padStart(3, "0")} finished work`, 0, 0));
		}
	}
}

function strip(rows: string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

function countNeedle(rows: string[], needle: string): number {
	return strip(rows).filter(row => row.includes(needle)).length;
}

const MODEL = {
	id: "composer-2.5",
	provider: "cursor",
	api: "anthropic-messages",
	contextWindow: 200_000,
	input: ["text"],
} as Model;

async function paintCompactionTicks(hostPin: boolean): Promise<{ tape: string[]; maintenance: number }> {
	const term = new VirtualTerminal(80, 12, 2_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });

	const history = new HistoryBlock(24);
	const todos = new AnchoredHud();
	todos.addChild(new Text("Todos · 3/3", 0, 0));
	todos.addChild(new Text(" └─ III. Verification · 3/3", 0, 0));
	todos.addChild(new Text("    ├─ ☑ Add tests", 0, 0));
	todos.addChild(new Text("    └─ ☑ Run full suite", 0, 0));
	const status = new AnchoredHud();

	const editor = new Container();
	for (let i = 0; i < 8; i++) {
		editor.addChild(new Text(i === 0 ? "> " : "", 0, 0));
	}

	tui.addChild(history);
	tui.addChild(todos);
	tui.addChild(status);
	tui.addChild(editor);

	const ctx = {
		isInitialized: true,
		focusedAgentId: undefined,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		settings: Settings,
		statusContainer: status,
		setStatusScrollbackPinned: (pinned: boolean) => {
			status.setNativeScrollbackPinned(pinned);
			if (hostPin) tui.setNativeScrollbackPinned(pinned);
		},
		noteDisplayableThinkingContent: () => false,
		showStatus: () => {},
		ui: {
			requestRender: () => tui.requestRender(),
			requestComponentRender: (component: unknown) => tui.requestComponentRender(component as never),
		},
	} as unknown as InteractiveModeContext;

	const controller = new CompactionController(ctx);
	try {
		tui.start();
		await scheduler.drain(term);

		controller.handleAutoCompactionStart({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "context-full",
		});
		controller.handleStart({
			type: "compaction_live_start",
			trigger: "auto",
			action: "context-full",
			reason: "threshold",
			phase: "history_summary",
			messagesTotal: 151,
			tokensBefore: 180_000,
		});
		controller.handleModel({
			type: "compaction_live_model",
			model: MODEL,
			thinkingLevel: ThinkingLevel.Off,
		});
		tui.requestRender();
		await scheduler.drain(term);

		for (let step = 0; step < 16; step++) {
			controller.handleProgress({
				type: "compaction_live_progress",
				phase: "history_summary",
				stepsDone: 0,
				stepsTotal: 2,
				messagesTotal: 151,
			});
			tui.requestRender();
			await scheduler.drain(term);
		}

		const tape = term.getScrollBuffer();
		return { tape, maintenance: countNeedle(tape, "Auto context-full maintenance") };
	} finally {
		controller.dispose();
		tui.stop();
		await term.flush();
	}
}

describe("compaction HUD native scrollback", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "display.smoothStreaming": false },
		});
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("keeps one Auto context-full maintenance frame while a live todo HUD owns the seam", async () => {
		const { tape, maintenance } = await paintCompactionTicks(true);
		expect(maintenance).toBe(1);
		expect(countNeedle(tape, "Compacting")).toBeLessThanOrEqual(1);
		expect(countNeedle(tape, "Summarizing history")).toBe(1);
	});
});
