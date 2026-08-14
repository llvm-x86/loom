import { escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import goalOuterDirectivePrompt from "../../prompts/goals/goal-outer-directive.md" with { type: "text" };
import type { GoalBilevelState, GoalSearchStrategy } from "./state";

/**
 * Process instruction paired with each strategy.
 *
 * Upstream injects the bare strategy token into the proposal prompt and lets the domain runner
 * interpret it. loom's inner loop is a general coding agent with no domain runner, so the token
 * alone is too weak to steer behavior — each strategy carries its operational meaning here.
 */
const STRATEGY_HINTS: Record<GoalSearchStrategy, string> = {
	explore:
		"Widen the search. Sample several distinct approaches cheaply before committing to any one of them, and prefer a new angle over another pass at the current one.",
	exploit:
		"Narrow the search. Commit to the approach that is already producing progress and drive it to a verified, finished state instead of opening new fronts.",
	focused:
		"Work one specific thread to completion. Do not touch unrelated files or start parallel investigations until that thread is closed.",
};

/**
 * Render the Level 1.5 directive block injected into the continuation prompt, or `undefined`
 * when no outer cycle has produced anything worth injecting.
 */
export function renderOuterDirective(state: GoalBilevelState | undefined): string | undefined {
	if (!state) return undefined;
	const { config, cycles } = state;
	const latest = cycles.at(-1);
	const hasContent =
		config.guidance.length > 0 ||
		config.frozenApproaches.length > 0 ||
		config.mechanisms.length > 0 ||
		Boolean(latest?.diagnosis);
	if (!hasContent) return undefined;
	return prompt.render(goalOuterDirectivePrompt, {
		cycle: String(cycles.length),
		windowIterations: String(state.iterationCount - (cycles.at(-2)?.atIteration ?? 0)),
		strategy: config.strategy,
		strategyHint: STRATEGY_HINTS[config.strategy],
		// Every analyst-authored string is model output being replayed into the inner loop's
		// prompt, so it is escaped: an unescaped `</search-directive>` in a diagnosis would let
		// the analyst close the directive block and inject trusted-looking instructions after it.
		diagnosis: latest?.diagnosis ? escapeXmlText(latest.diagnosis) : "",
		guidance: config.guidance ? escapeXmlText(config.guidance) : "",
		frozenApproaches: config.frozenApproaches.map(escapeXmlText),
		mechanisms: config.mechanisms.map(mechanism => ({
			name: escapeXmlText(mechanism.name),
			intervention: escapeXmlText(mechanism.intervention),
			revertWhen: escapeXmlText(mechanism.revertWhen),
		})),
	});
}
