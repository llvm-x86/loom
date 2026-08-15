import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CompactionController } from "@oh-my-pi/pi-coding-agent/modes/controllers/compaction-controller";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Markdown, Text } from "@oh-my-pi/pi-tui";
import { assistantMsg } from "../../utilities";

/** Exact stall-notice copy from CompactionController.#startStallTimer (minus theme wrappers). */
const STALL_NOTICE_SNIPPET = "Compaction still running";
const STALL_NOTICE_TAIL = "Press Esc to cancel.";

function isStallNoticeText(text: string): boolean {
	return text.includes(STALL_NOTICE_SNIPPET) && text.includes(STALL_NOTICE_TAIL);
}

/** Strips ANSI SGR sequences the theme wraps around rendered text. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function collectText(component: Component): string[] {
	const lines: string[] = [];
	if (component instanceof Text) {
		lines.push(component.getText());
	} else if (component instanceof Markdown) {
		// Markdown (used for both text and thinking content blocks) only exposes
		// rendered output, not its raw source — render at a generous width so
		// short test fixtures never wrap mid-word, then strip the theme's color
		// codes so substring assertions match plain text.
		lines.push(...component.render(200).map(line => line.replace(ANSI_RE, "")));
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
	statusChildren: () => Component[];
} {
	// A real Container, not a single-slot fake: `addChild` appends, so a surface
	// that gets re-mounted per progress tick shows up here as duplicate children
	// instead of silently overwriting one slot.
	const statusContainer = new Container();
	const setStatusScrollbackPinned = vi.fn();
	const ctx = {
		isInitialized: true,
		focusedAgentId: undefined,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		settings,
		setStatusScrollbackPinned,
		statusContainer,
		noteDisplayableThinkingContent: () => false,
		showStatus: options.showStatus ?? vi.fn(),
		// createAssistantMessageComponent reads ctx.viewSession.extensionRunner
		// unconditionally (no `?.` on viewSession itself) — omitting this threw
		// inside handleUpdate's try/catch, silently swallowing every assistant
		// component creation and leaving prior tests asserting on an empty surface.
		viewSession: { extensionRunner: undefined },
		ui: {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		root: () => statusContainer.children[0],
		statusChildren: () => statusContainer.children,
	};
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

	// Bound: `statusContainer` is a real Container whose `addChild` touches
	// `this.children`, so an unbound call throws (and the controller swallows it).
	const originalAddChild = ctx.statusContainer!.addChild.bind(ctx.statusContainer) as (child: Component) => void;
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

/** Minimal in-flight assistant message (stopReason "stop" — see AssistantMessageComponent#shouldAnimateThinking's doc comment: the streaming partial always reports "stop" until the turn finalizes). */
function streamingMsg(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

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
	// Regression: `Container.addChild` is an unconditional push and every event
	// handler calls `#ensureSurface()`, so re-mounting an already-mounted surface
	// stacked one full copy of the header/model/progress/spinner block per tick.
	// Operators saw the "Auto context-full maintenance…" block repeated dozens of
	// times per compaction.
	it("mounts exactly one surface across preparing, start and repeated progress", () => {
		const { ctx, statusChildren } = createContext();
		const controller = new CompactionController(ctx);

		controller.handlePreparingStart("manual");
		expect(statusChildren().length).toBe(1);

		controller.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 65,
			tokensBefore: 120_000,
		});
		expect(statusChildren().length).toBe(1);

		for (let step = 1; step <= 12; step++) {
			controller.handleProgress({
				type: "compaction_live_progress",
				phase: "turn_prefix",
				stepsDone: step,
				stepsTotal: 12,
				messagesTotal: 65,
			});
			controller.handleModel({
				type: "compaction_live_model",
				model: {
					id: "claude-opus-4-8",
					provider: "cursor",
					api: "anthropic-messages",
					contextWindow: 200_000,
					input: ["text"],
				} as Model,
				thinkingLevel: ThinkingLevel.Medium,
			});
		}

		expect(statusChildren().length).toBe(1);
		// One header, not twelve stacked copies of it.
		const occurrences = collectText(statusChildren()[0]!).join("\n").split("Compacting context").length - 1;
		expect(occurrences).toBeLessThanOrEqual(1);
	});

	it("pins scrollback while the compaction surface is live", () => {
		const { ctx } = createContext();
		const controller = new CompactionController(ctx);
		const pin = ctx.setStatusScrollbackPinned as ReturnType<typeof vi.fn>;

		controller.handleStart({
			type: "compaction_live_start",
			trigger: "auto",
			phase: "preparing",
			messagesTotal: 4,
			tokensBefore: 90_000,
		});
		expect(pin).toHaveBeenCalledWith(true);

		controller.handleEnd({
			type: "compaction_live_end",
			trigger: "auto",
			aborted: false,
			result: sampleResult,
		});
		expect(pin).toHaveBeenLastCalledWith(false);
	});

	it("does not dispose the status container during repeated progress", () => {
		const { ctx, statusChildren } = createContext();
		const disposeSpy = vi.spyOn(ctx.statusContainer, "disposeChildren");
		const controller = new CompactionController(ctx);

		controller.handleStart({
			type: "compaction_live_start",
			trigger: "manual",
			phase: "preparing",
			messagesTotal: 12,
			tokensBefore: 100_000,
		});
		disposeSpy.mockClear();

		for (let step = 1; step <= 12; step++) {
			controller.handleProgress({
				type: "compaction_live_progress",
				phase: "turn_prefix",
				stepsDone: step,
				stepsTotal: 12,
				messagesTotal: 12,
			});
		}

		expect(disposeSpy).not.toHaveBeenCalled();
		expect(statusChildren().length).toBe(1);
		disposeSpy.mockRestore();
	});

	// Regression: streaming compaction summary text (compaction_live_update) plus
	// progress/model ticks must not stack duplicate status blocks in scrollback.
	it("keeps one surface when summary text streams during progress", () => {
		const { ctx, statusChildren } = createContext();
		const controller = new CompactionController(ctx);
		const summary = assistantMsg("Continuing implementation of the Title I verification feature.");

		controller.handleStart({
			type: "compaction_live_start",
			trigger: "auto",
			phase: "preparing",
			messagesTotal: 20,
			tokensBefore: 180_000,
		});
		controller.handleModel({
			type: "compaction_live_model",
			model: {
				id: "composer-2.5",
				provider: "cursor",
				api: "anthropic-messages",
				contextWindow: 200_000,
				input: ["text"],
			} as Model,
			thinkingLevel: ThinkingLevel.Medium,
		});
		controller.handleProgress({
			type: "compaction_live_progress",
			phase: "short_summary",
			stepsDone: 2,
			stepsTotal: 3,
			messagesTotal: 20,
		});

		for (let chunk = 1; chunk <= 8; chunk++) {
			controller.handleUpdate({
				type: "compaction_live_update",
				message: summary,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: summary.content[0]?.text ?? "",
					partial: summary,
				},
			});
			controller.handleProgress({
				type: "compaction_live_progress",
				phase: "short_summary",
				stepsDone: 2,
				stepsTotal: 3,
				messagesDone: chunk,
				messagesTotal: 20,
			});
		}

		expect(statusChildren().length).toBe(1);
		const surfaceText = collectText(statusChildren()[0]!).join("\n");
		expect(surfaceText.split("Compacting context").length - 1).toBeLessThanOrEqual(1);
		expect(
			surfaceText.split("Continuing implementation of the Title I verification feature").length - 1,
		).toBeLessThanOrEqual(1);
	});

	// A surface detached by an unrelated `disposeChildren()` (auto-retry banner,
	// transient-UI teardown) has already been disposed, so its spinner is dead;
	// it must be rebuilt rather than re-attached.
	it("rebuilds the surface after a third party detaches it", () => {
		const { ctx, statusChildren } = createContext();
		const controller = new CompactionController(ctx);
		controller.handleStart({
			type: "compaction_live_start",
			trigger: "auto",
			phase: "preparing",
			messagesTotal: 4,
			tokensBefore: 90_000,
		});
		const first = statusChildren()[0];

		ctx.statusContainer.disposeChildren();
		expect(statusChildren().length).toBe(0);

		controller.handleProgress({
			type: "compaction_live_progress",
			phase: "history_summary",
			messagesDone: 2,
			messagesTotal: 4,
		});

		expect(statusChildren().length).toBe(1);
		expect(statusChildren()[0]).not.toBe(first);
		expect(collectText(statusChildren()[0]!).join("\n")).toContain("Summarizing history");
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

	// Regression: the stall notice passed `elapsedMs / 1000` (seconds) into
	// `formatDuration`, which expects milliseconds. A real elapsed of ~1000s
	// rendered as "(1.0s)" — the exact contradictory readout ("no updates for
	// 670s" next to "(1.0s)") reported against a live session.
	it("formats the stall notice's elapsed time as milliseconds, not seconds", () => {
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

		vi.advanceTimersByTime(1_000_000);
		const text = collectText(root()!).join("\n");
		expect(text).toContain("16m40s");
		expect(text).not.toContain("(1.0s)");
	});

	it("shows a retry notice with the candidate model and clears it on new progress", () => {
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

		controller.handleRetry({
			type: "compaction_live_retry",
			attempt: 1,
			maxRetries: 3,
			delayMs: 4000,
			model: { id: "k3", provider: "kimi-code", api: "anthropic-messages", contextWindow: 1_048_576, input: ["text"] } as Model,
			nextModel: false,
			reason: "Provider stream stalled",
		});
		const retryText = collectText(root()!).join("\n");
		expect(retryText).toContain("Provider stream stalled");
		expect(retryText).toContain("attempt 1/3");
		expect(retryText).toContain("4.0s");
		expect(retryText).toContain("kimi-code/k3");

		controller.handleProgress({
			type: "compaction_live_progress",
			phase: "history_summary",
			messagesDone: 1,
			messagesTotal: 2,
		});
		expect(collectText(root()!).join("\n")).not.toContain("Provider stream stalled");
	});

	it("labels a next-candidate retry notice distinctly from a same-model backoff", () => {
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

		controller.handleRetry({
			type: "compaction_live_retry",
			attempt: 1,
			maxRetries: 3,
			delayMs: 0,
			model: { id: "k3-256k", provider: "kimi-code", api: "anthropic-messages", contextWindow: 262_144, input: ["text"] } as Model,
			nextModel: true,
			reason: "Summarization timed out",
		});
		const text = collectText(root()!).join("\n");
		expect(text).toContain("trying next candidate model");
		expect(text).toContain("kimi-code/k3-256k");
	});


	// Regression: `compaction_live_model` fires again before every same-model
	// backoff retry and every candidate-fallback attempt, but `handleModel` used
	// to leave `#assistantComponent`/`#streamingReveal` wired to the *previous*
	// (failed) attempt. The retried attempt's message starts a brand-new stream
	// at content index 0 with unrelated text; `StreamingRevealController`
	// treats index-based updates as in-place appends, so the reveal cursor and
	// per-index grapheme cache from the aborted attempt bled into the new one —
	// visible as the previous attempt's thinking/output flashing in and mixing
	// with the retried attempt's content ("stuttering" at the retry boundary).
	it("clears the previous attempt's transcript before a retried model starts streaming", () => {
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

		const modelA = { id: "k3", provider: "kimi-code", api: "anthropic-messages", contextWindow: 1_048_576, input: ["text"] } as Model;
		controller.handleModel({ type: "compaction_live_model", model: modelA, thinkingLevel: ThinkingLevel.Medium });
		controller.handleUpdate({
			type: "compaction_live_update",
			message: streamingMsg([{ type: "thinking", thinking: "Attempt A reasoning AAAA" }]),
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Attempt A reasoning AAAA", partial: streamingMsg([{ type: "thinking", thinking: "Attempt A reasoning AAAA" }]) },
		});
		expect(collectText(root()!).join("\n")).toContain("Attempt A reasoning AAAA");

		// The candidate failed and a retry is starting: the stale attempt must be
		// gone from the transcript immediately, before any new content arrives.
		const modelB = { id: "k3-256k", provider: "kimi-code", api: "anthropic-messages", contextWindow: 262_144, input: ["text"] } as Model;
		controller.handleModel({ type: "compaction_live_model", model: modelB, thinkingLevel: ThinkingLevel.Medium });
		expect(collectText(root()!).join("\n")).not.toContain("Attempt A reasoning AAAA");

		controller.handleUpdate({
			type: "compaction_live_update",
			message: streamingMsg([{ type: "text", text: "Attempt B output BBBB" }]),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Attempt B output BBBB", partial: streamingMsg([{ type: "text", text: "Attempt B output BBBB" }]) },
		});
		const text = collectText(root()!).join("\n");
		expect(text).toContain("Attempt B output BBBB");
		expect(text).not.toContain("Attempt A reasoning AAAA");
	});

	it("mounts exactly one assistant-message surface across a candidate retry", () => {
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

		const modelA = { id: "k3", provider: "kimi-code", api: "anthropic-messages", contextWindow: 1_048_576, input: ["text"] } as Model;
		const modelB = { id: "k3-256k", provider: "kimi-code", api: "anthropic-messages", contextWindow: 262_144, input: ["text"] } as Model;

		const countAssistantComponents = (): number =>
			((root() as { children?: Component[] } | undefined)?.children ?? []).filter(
				child => child instanceof AssistantMessageComponent,
			).length;

		controller.handleModel({ type: "compaction_live_model", model: modelA, thinkingLevel: ThinkingLevel.Medium });
		controller.handleUpdate({
			type: "compaction_live_update",
			message: streamingMsg([{ type: "thinking", thinking: "reasoning" }]),
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "reasoning", partial: streamingMsg([{ type: "thinking", thinking: "reasoning" }]) },
		});
		expect(countAssistantComponents()).toBe(1);

		controller.handleModel({ type: "compaction_live_model", model: modelB, thinkingLevel: ThinkingLevel.Medium });
		expect(countAssistantComponents()).toBe(0);

		controller.handleUpdate({
			type: "compaction_live_update",
			message: streamingMsg([{ type: "text", text: "output" }]),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "output", partial: streamingMsg([{ type: "text", text: "output" }]) },
		});
		expect(countAssistantComponents()).toBe(1);
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
