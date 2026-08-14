import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { Container, Loader, Spacer, Text } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { formatModelSelectorValue } from "../../config/model-resolver";
import { settings } from "../../config/settings";
import { resolveCompactionStallNoticeSeconds } from "../../config/settings-schema";
import type {
	CompactionLiveAction,
	CompactionLiveEvent,
	CompactionLiveReason,
	CompactionLiveTrigger,
} from "../../session/context/compaction/live-events";
import type { AssistantMessageComponent } from "../components/assistant-message";
import { getSymbolTheme, theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import { splitAssistantMessageToolTimeline } from "../utils/transcript-render-helpers";
import { StreamingRevealController } from "./streaming-reveal";

const PHASE_LABELS: Record<string, string> = {
	preparing: "Preparing",
	snapcompact: "Snapcompact archive",
	remote_compaction: "Remote compaction",
	history_summary: "Summarizing history",
	turn_prefix: "Summarizing turn prefix",
	short_summary: "Writing short summary",
	summarizing: "Summarizing",
};

type AutoCompactionStartEvent = {
	type: "auto_compaction_start";
	reason: "threshold" | "overflow" | "idle" | "incomplete";
	action: "context-full" | "handoff" | "shake" | "snapcompact";
};

function formatPhaseLabel(phase: string): string {
	return PHASE_LABELS[phase] ?? phase.replace(/_/g, " ");
}

function formatProgressLine(update: {
	phase: string;
	messagesDone?: number;
	messagesTotal?: number;
	stepsDone?: number;
	stepsTotal?: number;
	detail?: string;
}): string {
	const phase = formatPhaseLabel(update.phase);
	const parts = [phase];
	if (update.stepsTotal !== undefined && update.stepsDone !== undefined) {
		parts.push(`step ${update.stepsDone}/${update.stepsTotal}`);
	} else if (update.messagesTotal !== undefined && update.messagesDone !== undefined) {
		parts.push(`${update.messagesDone}/${update.messagesTotal}`);
	} else if (update.messagesTotal !== undefined) {
		parts.push(`${update.messagesTotal} messages`);
	}
	if (update.detail) parts.push(update.detail);
	return parts.join(" · ");
}

function formatActionLabel(action: CompactionLiveAction | undefined, trigger: CompactionLiveTrigger): string {
	if (trigger === "manual") return "Compacting context";
	switch (action) {
		case "handoff":
			return "Auto-handoff";
		case "shake":
			return "Auto-shake";
		case "snapcompact":
			return "Auto-snapcompact";
		default:
			return "Auto context-full maintenance";
	}
}

function formatReasonPrefix(reason: CompactionLiveReason | undefined): string {
	switch (reason) {
		case "overflow":
			return "Context overflow detected, ";
		case "incomplete":
			return "Response incomplete, ";
		case "idle":
			return "Idle ";
		default:
			return "";
	}
}

function formatOutcomeLine(options: {
	result?: CompactionResult;
	modelLabel?: string;
	messagesTotal?: number;
	tokensBefore?: number;
}): string | undefined {
	if (!options.result) return undefined;
	const parts: string[] = [];
	if (options.messagesTotal !== undefined && options.messagesTotal > 0) {
		parts.push(`Compacted ${options.messagesTotal} messages`);
	}
	if (options.tokensBefore !== undefined && options.tokensBefore > 0) {
		parts.push(`was ~${Math.round(options.tokensBefore / 1000)}k tokens`);
	}
	if (options.modelLabel) parts.push(options.modelLabel);
	if (parts.length === 0) return undefined;
	return parts.join(" · ");
}

export class CompactionController {
	readonly #ctx: InteractiveModeContext;
	readonly #streamingReveal: StreamingRevealController;
	#root: Container | undefined;
	#headerText: Text | undefined;
	#modelText: Text | undefined;
	#progressText: Text | undefined;
	#stallText: Text | undefined;
	#assistantComponent: AssistantMessageComponent | undefined;
	#loader: Loader | undefined;
	#stallTimer: ReturnType<typeof setInterval> | undefined;
	#startedAt = 0;
	#lastActivityAt = 0;
	#active = false;
	/** Preparing surface shown for auto_compaction_start awaiting compaction_live_end. */
	#autoPreparingWithoutLive = false;
	#trigger: CompactionLiveTrigger = "manual";
	#messagesTotal: number | undefined;
	#tokensBefore: number | undefined;
	#modelLabel: string | undefined;

	constructor(ctx: InteractiveModeContext) {
		this.#ctx = ctx;
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: () => this.#ctx.settings.get("display.smoothStreaming"),
			getHideThinkingBlock: () => this.#ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => this.#ctx.proseOnlyThinking,
			requestRender: component => this.#ctx.ui.requestComponentRender(component),
		});
	}

	dispose(): void {
		this.#clearStallTimer();
		this.#streamingReveal.stop();
		try {
			this.#teardownSurface();
		} catch {
			// UI failures must not propagate.
		}
	}

	handleAutoCompactionStart(event: AutoCompactionStartEvent): void {
		this.#autoPreparingWithoutLive = true;
		this.#showPreparingSurface(event);
	}

	handlePreparingStart(trigger: CompactionLiveTrigger): void {
		try {
			// Manual compaction owns the surface; auto end must not reconcile it away.
			this.#autoPreparingWithoutLive = false;
			this.#trigger = trigger;
			this.#ensureSurface();
			this.#updateHeader(undefined, undefined, true);
			this.#ctx.ui.requestRender();
		} catch {
			// UI failures must not propagate.
		}
	}

	reconcileAutoCompactionEnd(): void {
		if (!this.#autoPreparingWithoutLive) return;
		this.#autoPreparingWithoutLive = false;
		try {
			this.#teardownSurface();
		} catch {
			// UI failures must not propagate.
		} finally {
			this.#active = false;
		}
	}

	isSurfaceLive(): boolean {
		return this.#active || this.#root !== undefined;
	}

	handleStart(event: Extract<CompactionLiveEvent, { type: "compaction_live_start" }>): void {
		try {
			this.#autoPreparingWithoutLive = false;
			this.#trigger = event.trigger;
			this.#messagesTotal = event.messagesTotal;
			this.#tokensBefore = event.tokensBefore;
			this.#modelLabel = undefined;
			this.#startedAt = Date.now();
			this.#touchActivity();
			this.#ensureSurface();
			this.#updateHeader(event.action, event.reason);
			this.#updateProgress({
				phase: event.phase,
				messagesTotal: event.messagesTotal,
			});
			this.#startStallTimer();
			this.#ctx.ui.requestRender();
		} catch {
			// UI failures must not propagate.
		}
	}

	handleProgress(event: Extract<CompactionLiveEvent, { type: "compaction_live_progress" }>): void {
		try {
			this.#touchActivity();
			this.#ensureSurface();
			this.#updateProgress(event);
			this.#ctx.ui.requestRender();
		} catch {
			// UI failures must not propagate.
		}
	}

	handleModel(event: Extract<CompactionLiveEvent, { type: "compaction_live_model" }>): void {
		try {
			this.#touchActivity();
			this.#modelLabel = formatModelSelectorValue(`${event.model.provider}/${event.model.id}`, event.thinkingLevel);
			this.#ensureSurface();
			this.#modelText?.setText(theme.fg("muted", `Model: ${this.#modelLabel}`));
			this.#ctx.ui.requestRender();
		} catch {
			// UI failures must not propagate.
		}
	}

	handleUpdate(event: Extract<CompactionLiveEvent, { type: "compaction_live_update" }>): void {
		try {
			this.#touchActivity();
			this.#ensureSurface();
			if (!this.#assistantComponent) {
				this.#assistantComponent = createAssistantMessageComponent(this.#ctx);
				this.#assistantComponent.setHideThinkingBlock(this.#ctx.effectiveHideThinkingBlock);
				this.#root?.addChild(this.#assistantComponent);
				this.#streamingReveal.begin(this.#assistantComponent, event.message);
			}
			const unlocked = this.#ctx.noteDisplayableThinkingContent?.(event.message);
			if (unlocked) {
				this.#assistantComponent.setHideThinkingBlock(this.#ctx.effectiveHideThinkingBlock);
				this.#streamingReveal.resyncVisibility();
			}
			this.#streamingReveal.setTarget(splitAssistantMessageToolTimeline(event.message).beforeTools);
			this.#ctx.ui.requestRender();
		} catch {
			// UI failures must not propagate.
		}
	}

	handleEnd(event: Extract<CompactionLiveEvent, { type: "compaction_live_end" }>): void {
		try {
			this.#clearStallTimer();
			this.#streamingReveal.stop();
			const outcome = formatOutcomeLine({
				result: event.result,
				modelLabel: event.modelLabel ?? this.#modelLabel,
				messagesTotal: this.#messagesTotal,
				tokensBefore: this.#tokensBefore,
			});
			this.#teardownSurface();
			if (event.aborted || event.errorMessage) return;
			if (outcome) {
				this.#ctx.showStatus(outcome, { dim: true });
			}
			this.#ctx.ui.requestRender();
		} catch {
			this.#teardownSurface();
		} finally {
			this.#autoPreparingWithoutLive = false;
			this.#active = false;
		}
	}

	#escHint(): string {
		return this.#ctx.focusedAgentId ? "" : " (esc to cancel)";
	}
	#showPreparingSurface(event: AutoCompactionStartEvent): void {
		try {
			this.#trigger = "auto";
			this.#ctx.statusContainer?.disposeChildren?.();
			this.#ensureSurface();
			this.#updateHeader(event.action, event.reason, true);
			this.#ctx.ui.requestRender();
		} catch {
			// UI failures must not propagate.
		}
	}
	/**
	 * Whether our surface is still attached to the status container. Asks the
	 * container's real child list rather than trusting a local flag, because a
	 * third party (auto-retry, transient-UI teardown) can detach us without
	 * telling us.
	 */
	#surfaceIsMounted(): boolean {
		if (!this.#root) return false;
		const children = (this.#ctx.statusContainer as { children?: unknown[] } | undefined)?.children;
		return Array.isArray(children) && children.includes(this.#root);
	}

	#ensureSurface(): void {
		const status = this.#ctx.statusContainer;
		if (!status) return;
		if (this.#root) {
			// `addChild` is an unconditional push, so re-adding a surface that is
			// still mounted stacks a whole duplicate copy of it — once per progress
			// tick, which is every LLM step of every compaction.
			if (this.#surfaceIsMounted()) {
				this.#active = true;
				return;
			}
			// Detached by someone else's `disposeChildren()`, which disposes as it
			// detaches: our Loader's timer is already dead, so this surface cannot
			// be remounted. Drop it and build a live one.
			this.#releaseSurfaceRefs();
		}
		this.#active = true;
		status.disposeChildren?.();
		this.#root = new Container();
		this.#root.addChild(new Spacer(1));
		this.#headerText = new Text("", 1, 0);
		this.#modelText = new Text("", 1, 0);
		this.#progressText = new Text("", 1, 0);
		this.#stallText = new Text("", 1, 0);
		this.#root.addChild(this.#headerText);
		this.#root.addChild(this.#modelText);
		this.#root.addChild(this.#progressText);
		this.#root.addChild(this.#stallText);
		this.#loader = new Loader(
			this.#ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			"",
			getSymbolTheme().spinnerFrames,
		);
		this.#root.addChild(this.#loader);
		status.addChild(this.#root);
	}

	#updateHeader(
		action: CompactionLiveAction | undefined,
		reason: CompactionLiveReason | undefined,
		preparing = false,
	): void {
		const label = formatActionLabel(action, this.#trigger);
		const prefix = formatReasonPrefix(reason);
		const suffix = preparing ? "preparing…" : "…";
		this.#headerText?.setText(theme.fg("accent", `${prefix}${label}${suffix}${this.#escHint()}`));
		this.#loader?.setMessage(theme.fg("muted", preparing ? "Preparing compaction…" : "Compacting…"));
	}

	#updateProgress(update: {
		phase: string;
		messagesDone?: number;
		messagesTotal?: number;
		stepsDone?: number;
		stepsTotal?: number;
		detail?: string;
	}): void {
		this.#progressText?.setText(theme.fg("muted", formatProgressLine(update)));
	}

	#touchActivity(): void {
		this.#lastActivityAt = Date.now();
		this.#stallText?.setText("");
	}

	#startStallTimer(): void {
		this.#clearStallTimer();
		const thresholdSeconds = resolveCompactionStallNoticeSeconds(settings.get("compaction.stallNoticeSeconds"));
		if (thresholdSeconds === 0) return;
		const thresholdMs = thresholdSeconds * 1000;
		this.#stallTimer = setInterval(() => {
			try {
				if (!this.#active || this.#lastActivityAt <= 0) return;
				const elapsedMs = Date.now() - this.#startedAt;
				const idleMs = Date.now() - this.#lastActivityAt;
				if (idleMs < thresholdMs) return;
				const elapsed = formatDuration(Math.floor(elapsedMs / 1000));
				this.#stallText?.setText(
					theme.fg(
						"warning",
						`Compaction still running (${elapsed}) — no updates for ${Math.floor(idleMs / 1000)}s. Press Esc to cancel.`,
					),
				);
				this.#ctx.ui.requestRender();
			} catch {
				// UI failures must not propagate.
			}
		}, 1000);
		this.#stallTimer.unref?.();
	}

	#clearStallTimer(): void {
		if (this.#stallTimer) {
			clearInterval(this.#stallTimer);
			this.#stallTimer = undefined;
		}
	}

	/** Drop every component reference without touching the status container. */
	#releaseSurfaceRefs(): void {
		this.#clearStallTimer();
		this.#streamingReveal.stop();
		if (this.#loader) {
			this.#loader.stop();
			this.#loader = undefined;
		}
		this.#root = undefined;
		this.#headerText = undefined;
		this.#modelText = undefined;
		this.#progressText = undefined;
		this.#stallText = undefined;
		this.#assistantComponent = undefined;
	}

	#teardownSurface(): void {
		this.#releaseSurfaceRefs();
		this.#ctx.statusContainer?.disposeChildren?.();
	}
}
