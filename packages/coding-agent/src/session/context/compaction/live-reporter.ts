import type { StreamFn, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation, CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { formatModelSelectorValue } from "../../../config/model-resolver";
import type {
	CompactionLiveAction,
	CompactionLiveEvent,
	CompactionLiveReason,
	CompactionLiveTrigger,
	CompactionProgressUpdate,
} from "./live-events";
import { createCompactionStreamCompleteImpl } from "./stream-bridge";

type EmitFn = (event: CompactionLiveEvent) => void | Promise<void>;

export class CompactionLiveReporter {
	#emit: EmitFn;
	#sideStreamFn: StreamFn;
	#trigger: CompactionLiveTrigger;
	#messagesTotal = 0;
	#modelLabel: string | undefined;
	#active = false;

	constructor(options: { emit: EmitFn; sideStreamFn: StreamFn; trigger: CompactionLiveTrigger }) {
		this.#emit = options.emit;
		this.#sideStreamFn = options.sideStreamFn;
		this.#trigger = options.trigger;
	}

	get modelLabel(): string | undefined {
		return this.#modelLabel;
	}

	get isActive(): boolean {
		return this.#active;
	}

	/** Silence a displaced reporter so it never emits again. */
	deactivate(): void {
		this.#active = false;
	}

	start(options: {
		preparation: CompactionPreparation;
		action?: CompactionLiveAction;
		reason?: CompactionLiveReason;
		phase?: string;
	}): void {
		const { preparation, action, reason, phase = "preparing" } = options;
		this.#messagesTotal =
			preparation.messagesToSummarize.length +
			preparation.turnPrefixMessages.length +
			(preparation.recentMessages.length > 0 ? 1 : 0);
		this.#active = true;
		void this.#safeEmit({
			type: "compaction_live_start",
			trigger: this.#trigger,
			action,
			reason,
			phase,
			messagesTotal: this.#messagesTotal,
			tokensBefore: preparation.tokensBefore,
		});
	}

	progress(update: CompactionProgressUpdate): void {
		if (!this.#active) return;
		void this.#safeEmit({
			type: "compaction_live_progress",
			phase: update.phase,
			messagesDone: update.messagesDone,
			messagesTotal:
				update.stepsDone === undefined ? (update.messagesTotal ?? this.#messagesTotal) : update.messagesTotal,
			stepsDone: update.stepsDone,
			stepsTotal: update.stepsTotal,
			detail: update.detail,
		});
	}

	model(model: Model, thinkingLevel?: ThinkingLevel): void {
		if (!this.#active) return;
		this.#modelLabel = formatModelSelectorValue(`${model.provider}/${model.id}`, thinkingLevel);
		void this.#safeEmit({ type: "compaction_live_model", model, thinkingLevel });
	}

	createCompleteImpl(): <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage> {
		return createCompactionStreamCompleteImpl(this.#sideStreamFn, (message, event) => {
			if (!this.#active) return;
			void this.#safeEmit({
				type: "compaction_live_update",
				message,
				assistantMessageEvent: event,
			});
		});
	}

	onProgress = (update: CompactionProgressUpdate): void => {
		this.progress(update);
	};

	async end(options: { aborted: boolean; errorMessage?: string; result?: CompactionResult }): Promise<void> {
		if (!this.#active) return;
		this.#active = false;
		await this.#safeEmit({
			type: "compaction_live_end",
			trigger: this.#trigger,
			aborted: options.aborted,
			errorMessage: options.errorMessage,
			result: options.result,
			modelLabel: this.#modelLabel,
		});
	}

	async #safeEmit(event: CompactionLiveEvent): Promise<void> {
		try {
			await this.#emit(event);
		} catch {
			// Rendering must never surface into compaction.
		}
	}
}
