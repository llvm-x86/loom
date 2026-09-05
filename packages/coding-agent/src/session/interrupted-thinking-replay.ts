import type { Context, DeveloperMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import interruptedThinkingRedactedTemplate from "../prompts/system/interrupted-thinking-redacted.md" with {
	type: "text",
};

/**
 * The interrupted-thinking continuity notice replays the previous turn's
 * reasoning as user-visible text (`interrupted-thinking.md`). To Anthropic's
 * signing endpoints that is exactly the input the `reasoning_extraction`
 * classifier exists to block: measured live on Fable 5.1, a bare "proceed"
 * carrying one such notice was refused, while the same request without the
 * notice — or with the reasoning demoted inside assistant history and then
 * dropped by the provider's retry — completed. No provider-side retry can
 * recover it, because the reasoning sits in a *user* message the provider has
 * no license to edit.
 *
 * This is the same policy `transform-messages.ts` already applies to unsigned
 * thinking blocks headed for a signing Anthropic target (drop, never demote to
 * text), applied to the one place coding-agent itself turns reasoning into
 * text. Runs in `transformProviderContext`, after `convertToLlm`, because the
 * notice is persisted with the reasoning baked in at interrupt time and the
 * refusing model is whichever one the session is on *now* — typically a
 * different one, since compaction or a model switch is what interrupts.
 */
function isSigningAnthropicTarget(model: Model): boolean {
	return isAnthropicMessagesModel(model) && model.compat.signingEndpoint;
}

function isAnthropicMessagesModel(model: Model): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages";
}

export function redactInterruptedThinkingForModel(context: Context, model: Model): Context {
	if (!isSigningAnthropicTarget(model)) return context;
	let changed = false;
	const messages = context.messages.map(message => {
		if (message.role !== "user" && message.role !== "developer") return message;
		const next = redactMessage(message);
		if (next !== message) changed = true;
		return next;
	});
	return changed ? { ...context, messages } : context;
}

const NOTICE_PATTERN = /<system-notice type="interrupted-thinking">[\s\S]*?<\/system-notice>/g;
const REDACTED_NOTICE = interruptedThinkingRedactedTemplate.trim();

function redactText(text: string): string {
	return text.includes('<system-notice type="interrupted-thinking">')
		? text.replace(NOTICE_PATTERN, REDACTED_NOTICE)
		: text;
}

function redactMessage<T extends UserMessage | DeveloperMessage>(message: T): T {
	if (typeof message.content === "string") {
		const text = redactText(message.content);
		return text === message.content ? message : { ...message, content: text };
	}
	let changed = false;
	const content = message.content.map(block => {
		if (block.type !== "text") return block;
		const text = redactText(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? { ...message, content } : message;
}
