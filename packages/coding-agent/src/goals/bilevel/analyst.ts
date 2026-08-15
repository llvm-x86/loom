import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Tool } from "@oh-my-pi/pi-ai";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../../commit/utils";
import type { ResolvedModelRoleValue } from "../../config/model-resolver";
import goalOuterAnalysisPrompt from "../../prompts/goals/goal-outer-analysis.md" with { type: "text" };
import goalOuterSystemPrompt from "../../prompts/goals/goal-outer-system.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import { concreteThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "../../thinking";
import type { OuterAnalysisResult } from "./analysis";
import { parseOuterAnalysis } from "./analysis";
import type { GoalBilevelState } from "./state";
import { buildTraceDigest } from "./trace";

/**
 * Model-role preference order for the outer analyst. `goalOuter` is the dedicated role `/goal`
 * assigns during search setup; the reasoning roles are the fallback for installs that never ran it.
 */
export const OUTER_MODEL_ROLES = ["goalOuter", "plan", "slow"] as const;

const ANALYSIS_TOOL_NAME = "analysis";

const ANALYSIS_TOOL: Tool = {
	name: ANALYSIS_TOOL_NAME,
	description: "Return the outer-loop analysis of the inner loop's search behavior.",
	parameters: {
		type: "object",
		properties: {
			diagnosis: { type: "string", description: "What the inner loop is doing right or wrong." },
			strategy: { type: "string", enum: ["explore", "exploit", "focused"] },
			freezeApproaches: {
				type: "array",
				items: { type: "string" },
				description: "Approaches the inner loop must stop retrying, named specifically.",
			},
			unfreezeApproaches: {
				type: "array",
				items: { type: "string" },
				description: "Previously frozen approaches that are worth reopening.",
			},
			guidance: {
				type: "string",
				description: "Process guidance injected into the inner loop's next prompt. Replaces prior guidance.",
			},
			reasoning: { type: "string", description: "Why these changes to the search configuration." },
			mechanism: {
				type: "object",
				description: "Optional named intervention for a stagnating loop.",
				properties: {
					name: { type: "string" },
					trigger: { type: "string" },
					intervention: { type: "string" },
					revertWhen: { type: "string" },
				},
			},
			retireMechanisms: {
				type: "array",
				items: { type: "string" },
				description: "Names of active mechanisms whose revert condition is now satisfied.",
			},
		},
		required: ["diagnosis", "strategy", "guidance"],
	},
	strict: false,
};

export interface OuterAnalysisRequest {
	objective: string;
	state: GoalBilevelState;
	signal?: AbortSignal;
}

export type { OuterAnalysisResult };

/**
 * Resolve the model that {@link runOuterAnalysis} will actually run on: the dedicated
 * `goalOuter` role when configured, falling back to `plan`, then `slow`, then the session's
 * own model. Shared with the `/goal` status display so the reported model is never a guess.
 */
export function resolveOuterAnalystModel(session: AgentSession): ResolvedModelRoleValue {
	let resolved: ResolvedModelRoleValue = {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		explicitThinkingLevel: false,
		warning: undefined,
	};
	for (const role of OUTER_MODEL_ROLES) {
		const candidate = session.resolveRoleModelWithThinking(role);
		if (!candidate.model) continue;
		resolved = candidate;
		break;
	}
	return resolved;
}

/**
 * Run one Level 1.5 outer-loop analysis.
 *
 * Mirrors `runGuidedGoalTurn`: a oneshot forced-tool-call completion routed through the session
 * transport on a distinct side-session id, so the analyst never pollutes the main conversation.
 * The model comes from {@link resolveOuterAnalystModel}.
 *
 * Returns `undefined` rather than throwing when the analyst is unusable. Upstream `_analyze`
 * degrades the same way — a failed analysis leaves the search configuration untouched, because a
 * broken meta-optimizer must not be able to derail a working inner loop.
 */
export async function runOuterAnalysis(
	session: AgentSession,
	request: OuterAnalysisRequest,
): Promise<OuterAnalysisResult | undefined> {
	const resolved = resolveOuterAnalystModel(session);
	if (!resolved.model) return undefined;

	const apiKey = await session.modelRegistry.getApiKey(resolved.model, session.sessionId);
	if (!apiKey) return undefined;

	const { state, objective } = request;
	const digest = buildTraceDigest(state, state.config);
	const userPrompt = prompt.render(goalOuterAnalysisPrompt, {
		objective,
		iterationLines: digest.iterationLines,
		toolHistogram: digest.toolHistogram,
		windowIterations: String(digest.windowIterations),
		totalIterations: String(digest.totalIterations),
		distinctSignatures: String(digest.distinctSignatures),
		totalToolCalls: String(digest.totalToolCalls),
		totalFailures: String(digest.totalFailures),
		goalToolTouches: String(digest.goalToolTouches),
		totalTokens: String(digest.totalTokens),
		stagnationReason: digest.stagnation.reason,
		strategy: state.config.strategy,
		frozenApproaches: state.config.frozenApproaches.join("; ") || "(none)",
		guidance: state.config.guidance || "(none)",
		mechanisms: state.config.mechanisms.map(mechanism => mechanism.name).join("; ") || "(none)",
	});

	// Secret obfuscation: the objective is user-authored and the trace names tools the user may
	// have configured, so route the prompt through the session obfuscator exactly as normal turns
	// do. The reply is process guidance that is re-injected into the inner loop, so it is
	// deobfuscated below before it reaches the continuation prompt.
	const obfuscator = session.obfuscator;
	const promptText = obfuscator?.hasSecrets() ? obfuscator.obfuscate(userPrompt) : userPrompt;
	const thinkingLevel = concreteThinkingLevel(resolved.thinkingLevel);

	let response: Awaited<ReturnType<typeof instrumentedCompleteSimple>>;
	try {
		response = await instrumentedCompleteSimple(
			resolved.model,
			{
				systemPrompt: [prompt.render(goalOuterSystemPrompt)],
				messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
				tools: [ANALYSIS_TOOL],
			},
			{
				apiKey: session.modelRegistry.resolver(resolved.model, session.sessionId),
				signal: request.signal,
				reasoning: toReasoningEffort(thinkingLevel),
				disableReasoning: shouldDisableReasoning(thinkingLevel),
				toolChoice: { type: "tool", name: ANALYSIS_TOOL_NAME },
				sessionId: `${session.sessionId}:goal-outer:${Snowflake.next()}`,
				promptCacheKey: session.sessionId,
				preferWebsockets: session.preferWebsockets,
				providerSessionState: session.providerSessionState,
			},
			{
				telemetry: resolveTelemetry(session.agent.telemetry, session.sessionId),
				oneshotKind: "goal_outer_analysis",
			},
		);
	} catch {
		return undefined;
	}

	if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;

	let payload: unknown;
	const call = extractToolCall(response, ANALYSIS_TOOL_NAME);
	try {
		if (call) {
			payload = typeof call.arguments === "string" ? parseJsonPayload(call.arguments) : call.arguments;
		} else {
			const text = extractTextContent(response);
			if (!text) return undefined;
			payload = parseJsonPayload(text);
		}
	} catch {
		return undefined;
	}

	const analysis = parseOuterAnalysis(payload);
	if (!analysis) return undefined;
	if (!obfuscator?.hasSecrets()) return { analysis, stagnation: digest.stagnation.reason };
	return {
		analysis: {
			...analysis,
			diagnosis: obfuscator.deobfuscate(analysis.diagnosis),
			guidance: obfuscator.deobfuscate(analysis.guidance),
			reasoning: obfuscator.deobfuscate(analysis.reasoning),
			// Every name-shaped field is mapped too, not just prose: freeze/unfreeze and retire
			// entries are matched by name against already-deobfuscated state, so leaving a
			// placeholder in one of them would silently never match.
			freezeApproaches: analysis.freezeApproaches.map(entry => obfuscator.deobfuscate(entry)),
			unfreezeApproaches: analysis.unfreezeApproaches.map(entry => obfuscator.deobfuscate(entry)),
			retireMechanisms: analysis.retireMechanisms.map(entry => obfuscator.deobfuscate(entry)),
			mechanism: analysis.mechanism
				? {
						name: obfuscator.deobfuscate(analysis.mechanism.name),
						intervention: obfuscator.deobfuscate(analysis.mechanism.intervention),
						trigger: obfuscator.deobfuscate(analysis.mechanism.trigger),
						revertWhen: obfuscator.deobfuscate(analysis.mechanism.revertWhen),
					}
				: undefined,
		},
		stagnation: digest.stagnation.reason,
	};
}
