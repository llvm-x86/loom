import type { GoalBilevelState, GoalIterationRecord, GoalSearchConfig } from "./state";
import { iterationSignature, MAX_ITERATION_TOOLS, TRACE_CAPACITY } from "./state";

/** Input for recording one inner-loop iteration. */
export interface GoalIterationInput {
	tools: readonly string[];
	failedTools: readonly string[];
	tokens: number;
	durationMs: number;
	goalToolUsed: boolean;
}

export function recordIteration(state: GoalBilevelState, input: GoalIterationInput): GoalIterationRecord {
	state.iterationCount += 1;
	const record: GoalIterationRecord = {
		iteration: state.iterationCount,
		// A tool-heavy iteration is a process signal, not a transcript: keep the head at the same
		// cap the parser enforces so neither the persisted record nor the rendered digest line
		// scales with call count. The signature below still sees every call.
		tools: input.tools.slice(0, MAX_ITERATION_TOOLS),
		failedTools: input.failedTools.slice(0, MAX_ITERATION_TOOLS),
		tokens: input.tokens,
		durationMs: input.durationMs,
		goalToolUsed: input.goalToolUsed,
		signature: iterationSignature(input.tools),
	};
	state.trace.push(record);
	if (state.trace.length > TRACE_CAPACITY) {
		state.trace.splice(0, state.trace.length - TRACE_CAPACITY);
	}
	return record;
}

/** Whether an outer cycle is due. Upstream cadence: one analysis per `inner_budget` iterations. */
export function isOuterCycleDue(state: GoalBilevelState): boolean {
	const budget = Math.max(1, state.config.innerBudget);
	return state.iterationCount - state.lastAnalyzedIteration >= budget;
}

export interface ToolStat {
	tool: string;
	used: number;
	failed: number;
}

/**
 * Per-tool usage histogram — the loom analogue of upstream `change_history`
 * ("PARAM: tried Nx, kept Mx", train_opt/outer.py `_analyze`). Upstream counts how often a
 * search dimension was perturbed versus how often that paid off; loom counts how often a tool
 * was used versus how often it errored, which is the observable available at `tool_execution_end`.
 */
export function toolStats(trace: readonly GoalIterationRecord[]): ToolStat[] {
	const stats = new Map<string, ToolStat>();
	for (const record of trace) {
		for (const tool of record.tools) {
			let stat = stats.get(tool);
			if (!stat) {
				stat = { tool, used: 0, failed: 0 };
				stats.set(tool, stat);
			}
			stat.used += 1;
		}
		for (const tool of record.failedTools) {
			const stat = stats.get(tool);
			if (stat) stat.failed += 1;
		}
	}
	return [...stats.values()].sort((a, b) => b.used - a.used || a.tool.localeCompare(b.tool));
}

export interface StagnationVerdict {
	stagnating: boolean;
	/** Human-readable reason, forwarded to the outer analyst. Empty when not stagnating. */
	reason: string;
	/** Signature repeated most often within the window, when repetition is the cause. */
	repeatedSignature?: string;
}

/**
 * Mechanical stagnation detector over the most recent `window` iterations.
 *
 * Upstream leaves the stuck/not-stuck judgement to the outer LLM (it is prompted with
 * "If the inner loop is stuck, make a significant strategy shift") and its published tabu
 * mechanism is itself a *discovered* Level 2 artifact rather than framework code. This detector
 * is therefore a loom addition, used only to decide when to escalate from Level 1.5 (rewrite the
 * config) to Level 2 (propose a mechanism). The LLM still receives the raw histogram and makes
 * the freeze and strategy calls itself.
 *
 * Both rules are deliberately coarse: they fire on observable repetition and observable failure,
 * never on a guess about whether the underlying work is "going well".
 */
export function detectStagnation(trace: readonly GoalIterationRecord[], window: number): StagnationVerdict {
	const recent = trace.slice(-Math.max(1, window));
	if (recent.length < 3) return { stagnating: false, reason: "" };

	const counts = new Map<string, number>();
	for (const record of recent) {
		counts.set(record.signature, (counts.get(record.signature) ?? 0) + 1);
	}
	let topSignature = "";
	let topCount = 0;
	for (const [signature, count] of counts) {
		if (count > topCount) {
			topSignature = signature;
			topCount = count;
		}
	}
	if (topCount >= 3) {
		return {
			stagnating: true,
			reason: `the same tool signature (${topSignature}) repeated ${topCount}x in the last ${recent.length} iterations`,
			repeatedSignature: topSignature,
		};
	}

	const totalCalls = recent.reduce((sum, record) => sum + record.tools.length, 0);
	const totalFailures = recent.reduce((sum, record) => sum + record.failedTools.length, 0);
	if (totalCalls >= 5 && totalFailures * 2 > totalCalls) {
		return {
			stagnating: true,
			reason: `${totalFailures} of ${totalCalls} tool calls failed in the last ${recent.length} iterations`,
		};
	}

	return { stagnating: false, reason: "" };
}

/**
 * Process-signal digest handed to the outer analyst.
 *
 * Carries no file contents, tool output, or assistant text — see the isolation note on
 * `GoalIterationRecord`.
 */
export interface GoalTraceDigest {
	iterationLines: string;
	toolHistogram: string;
	totalIterations: number;
	windowIterations: number;
	distinctSignatures: number;
	totalToolCalls: number;
	totalFailures: number;
	goalToolTouches: number;
	totalTokens: number;
	stagnation: StagnationVerdict;
}

function formatIteration(record: GoalIterationRecord): string {
	const tools = record.tools.length > 0 ? record.tools.join(", ") : "(no tools)";
	const failed = record.failedTools.length > 0 ? ` failed=[${record.failedTools.join(", ")}]` : "";
	const goalTool = record.goalToolUsed ? " goal-tool" : "";
	const seconds = (record.durationMs / 1000).toFixed(1);
	return `  #${record.iteration}: [${tools}]${failed} tokens=${record.tokens} ${seconds}s${goalTool}`;
}

export function buildTraceDigest(state: GoalBilevelState, config: GoalSearchConfig): GoalTraceDigest {
	const window = Math.max(1, config.innerBudget) * 2;
	const recent = state.trace.slice(-window);
	const stats = toolStats(recent);
	return {
		iterationLines: recent.map(formatIteration).join("\n") || "  (no iterations recorded)",
		toolHistogram:
			stats.map(stat => `  ${stat.tool}: used ${stat.used}x, failed ${stat.failed}x`).join("\n") ||
			"  (no tool calls yet)",
		totalIterations: state.iterationCount,
		windowIterations: recent.length,
		distinctSignatures: new Set(recent.map(record => record.signature)).size,
		totalToolCalls: recent.reduce((sum, record) => sum + record.tools.length, 0),
		totalFailures: recent.reduce((sum, record) => sum + record.failedTools.length, 0),
		goalToolTouches: recent.filter(record => record.goalToolUsed).length,
		totalTokens: recent.reduce((sum, record) => sum + record.tokens, 0),
		stagnation: detectStagnation(state.trace, Math.max(1, config.innerBudget)),
	};
}
