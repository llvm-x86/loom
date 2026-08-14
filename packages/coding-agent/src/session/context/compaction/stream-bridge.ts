import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";

type StreamUpdateHandler = (message: AssistantMessage, event: AssistantMessageEvent) => void;

const STREAMING_EVENT_TYPES = new Set<AssistantMessageEvent["type"]>([
	"start",
	"text_start",
	"text_delta",
	"text_end",
	"thinking_start",
	"thinking_delta",
	"thinking_end",
	"image_end",
]);

/**
 * Wrap the session side-stream transport so compaction summarization emits the
 * same assistant stream events the live turn path consumes, without awaiting
 * only the terminal message.
 */
export function createCompactionStreamCompleteImpl(
	sideStreamFn: StreamFn,
	onUpdate: StreamUpdateHandler,
): <TApi extends Api>(model: Model<TApi>, ctx: Context, options: SimpleStreamOptions) => Promise<AssistantMessage> {
	return async (model, ctx, options) => {
		const stream = await sideStreamFn(model, ctx, options);
		for await (const event of stream) {
			if (!STREAMING_EVENT_TYPES.has(event.type)) continue;
			if (!("partial" in event) || !event.partial) continue;
			try {
				onUpdate(event.partial, event);
			} catch {
				// UI hooks must never abort compaction.
			}
		}
		return stream.result();
	};
}
