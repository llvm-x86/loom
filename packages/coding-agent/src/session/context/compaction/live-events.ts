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
	  };

export type CompactionProgressUpdate = {
	phase: string;
	messagesDone?: number;
	messagesTotal?: number;
	stepsDone?: number;
	stepsTotal?: number;
	detail?: string;
};
