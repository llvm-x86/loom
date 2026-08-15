import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@oh-my-pi/pi-ai";

export type CompactionLiveTrigger = "manual" | "auto";

export type CompactionLiveAction = "context-full" | "handoff" | "shake" | "snapcompact";

export type CompactionLiveReason = "threshold" | "overflow" | "idle" | "incomplete";

export type CompactionLiveEvent =
	| {
			type: "compaction_live_start";
			trigger: CompactionLiveTrigger;
			action?: CompactionLiveAction;
			reason?: CompactionLiveReason;
			phase: string;
			messagesTotal: number;
			tokensBefore: number;
	  }
	| {
			type: "compaction_live_progress";
			phase: string;
			messagesDone?: number;
			messagesTotal?: number;
			stepsDone?: number;
			stepsTotal?: number;
			detail?: string;
	  }
	| {
			type: "compaction_live_model";
			model: Model;
			thinkingLevel?: ThinkingLevel;
	  }
	| {
			type: "compaction_live_update";
			message: AssistantMessage;
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| {
			type: "compaction_live_end";
			trigger: CompactionLiveTrigger;
			aborted: boolean;
			errorMessage?: string;
			result?: CompactionResult;
			modelLabel?: string;
	  }
	| {
			/**
			 * A transient failure is being retried — either the same candidate after a
			 * backoff delay, or the next candidate in the fallback chain. Emitted so the
			 * UI can replace the generic "no updates" stall notice with the concrete
			 * reason nothing has streamed yet.
			 */
			type: "compaction_live_retry";
			/** 1-based attempt number for the *current* candidate model. */
			attempt: number;
			maxRetries: number;
			/** Wait before the next attempt, in ms. `0` when moving to the next candidate immediately. */
			delayMs: number;
			model: Model;
			/** `true` when this retry moves on to a different candidate model instead of reusing the current one. */
			nextModel: boolean;
			reason: string;
	  };

export type CompactionProgressUpdate = {
	phase: string;
	messagesDone?: number;
	messagesTotal?: number;
	stepsDone?: number;
	stepsTotal?: number;
	detail?: string;
};
