import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/compaction-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, type NativeScrollbackLiveRegion, Text, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { assistantMsg } from "../../utilities";

/**
 * Operator transcript this guards:
 *
 *   Compacting context… (esc to cancel)
 *   Model: cursor/composer-2.5:off
 *   Writing short summary · step 2/3
 *   ⠦ Compacting…
 *   <streamed Title I summary paragraphs>
 *
 * The summary is the compaction model's output, not a second job. A live HUD
 * that grows while earlier rows wrap/reflow used to freeze a first copy into
 * native scrollback, then ED3-reset mid-stream and write the HUD again.
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

const SUMMARY = [
	"Continuing the Title I verification implementation.",
	"",
	"Title I verification will be advisory and non-blocking. The Urban Institute Education Data Portal API will handle lookups. A staff manual override will be included. Title I status remains separate from tax exemption. School name and city location filters were previously ignored.",
	"",
	"A dedicated title_one_verification module will query the Urban Institute API. Results will be stored on bookings alongside existing tax verification patterns. The UI will display advisory status and allow staff overrides. Pricing will remain unchanged until verification completes.",
	"",
	"The current title_one field is just a boolean with no verification logic. The API does not filter well by school name, so client-side filtering or a NCES ID lookup may be needed instead.",
	"",
	"Implementing advisory Title I verification with staff override, mirroring the existing tax-verification pattern. Exploring the codebase first.",
].join("\n");

function updateEvent(text: string): {
	type: "compaction_live_update";
	message: AssistantMessage;
	assistantMessageEvent: {
		type: "text_delta";
		contentIndex: 0;
		delta: string;
		partial: AssistantMessage;
	};
} {
	const message = assistantMsg(text) as AssistantMessage;
	return {
		type: "compaction_live_update",
		message,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: text,
			partial: message,
		},
	};
}

type PaintResult = {
	tape: string[];
	viewport: string[];
	headers: number;
	viewportHeaders: number;
	extraRedraws: number;
	ed3DuringStream: number;
};

async function paintManualSummaryStream(hostPin: boolean): Promise<PaintResult> {
	const term = new VirtualTerminal(80, 16, 4_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const writes: string[] = [];
	const originalWrite = term.write.bind(term);
	term.write = (data: string) => {
		writes.push(data);
		originalWrite(data);
	};

	const history = new HistoryBlock(36);
	const status = new AnchoredHud();
	const editor = new Container();
	for (let i = 0; i < 6; i++) {
		editor.addChild(new Text(i === 0 ? "> " : "", 0, 0));
	}

	tui.addChild(history);
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

		controller.handlePreparingStart("manual");
		controller.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "short_summary",
			messagesTotal: 25,
			tokensBefore: 200_000,
		});
		controller.handleModel({
			type: "compaction_live_model",
			model: MODEL,
			thinkingLevel: ThinkingLevel.Off,
		});
		controller.handleProgress({
			type: "compaction_live_progress",
			phase: "short_summary",
			stepsDone: 2,
			stepsTotal: 3,
			messagesTotal: 25,
		});
		tui.requestRender();
		await scheduler.drain(term);

		const redrawsAtHud = tui.fullRedraws;
		const writesAtHud = writes.length;

		const step = Math.max(24, Math.floor(SUMMARY.length / 12));
		for (let n = step; n <= SUMMARY.length; n += step) {
			controller.handleUpdate(updateEvent(SUMMARY.slice(0, n)));
			controller.handleProgress({
				type: "compaction_live_progress",
				phase: "short_summary",
				stepsDone: 2,
				stepsTotal: 3,
				messagesTotal: 25,
			});
			tui.requestRender();
			await scheduler.drain(term);
		}

		const extraRedraws = tui.fullRedraws - redrawsAtHud;
		const ed3DuringStream = writes
			.slice(writesAtHud)
			.filter(write => write.includes("\x1b[3J") || write.includes("\x1b[2J")).length;

		const tape = term.getScrollBuffer();
		const viewport = term.getViewport();
		return {
			tape,
			viewport,
			headers: countNeedle(tape, "Compacting context"),
			viewportHeaders: countNeedle(viewport, "Compacting context"),
			extraRedraws,
			ed3DuringStream,
		};
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

	it("does not ED3-reset a growing Compacting context HUD mid-stream", async () => {
		const painted = await paintManualSummaryStream(true);
		expect(painted.viewportHeaders).toBe(1);
		expect(painted.headers).toBe(1);
		expect(painted.extraRedraws).toBe(0);
		expect(painted.ed3DuringStream).toBe(0);
	});
});
