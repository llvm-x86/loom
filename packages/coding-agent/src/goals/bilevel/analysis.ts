import type { GoalBilevelState, GoalMechanism, GoalOuterCycle, GoalSearchStrategy } from "./state";
import { GOAL_SEARCH_STRATEGIES, MAX_ACTIVE_MECHANISMS, MAX_FREEZE_PER_CYCLE, MAX_FROZEN_APPROACHES } from "./state";

/** Proposed Level 2 mechanism, before validation. */
export interface GoalMechanismProposal {
	name: string;
	trigger: string;
	intervention: string;
	revertWhen: string;
}

/**
 * Outer-loop analysis payload.
 *
 * Field-for-field port of the JSON contract in train_opt/outer.py `OUTER_PROMPT`
 * (`diagnosis`, `strategy`, `freeze_params`, `unfreeze_params`, `guidance`, `reasoning`),
 * plus the two Level 2 fields loom needs to carry mechanisms across cycles.
 */
export interface GoalOuterAnalysis {
	diagnosis: string;
	strategy: GoalSearchStrategy;
	freezeApproaches: string[];
	unfreezeApproaches: string[];
	guidance: string;
	reasoning: string;
	mechanism?: GoalMechanismProposal;
	retireMechanisms: string[];
}

/** Outcome of one Level 1.5 analysis: the parsed payload plus the stagnation reason it saw. */
export interface OuterAnalysisResult {
	analysis: GoalOuterAnalysis;
	stagnation: string;
}

function asTrimmedString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		const text = asTrimmedString(entry);
		if (text) out.push(text);
	}
	return out;
}

function parseMechanism(value: unknown): GoalMechanismProposal | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const name = asTrimmedString(raw.name);
	const intervention = asTrimmedString(raw.intervention);
	// A mechanism with no name or no intervention cannot be installed, injected, or retired,
	// so an incomplete proposal is dropped rather than half-applied.
	if (!name || !intervention) return undefined;
	return {
		name,
		intervention,
		trigger: asTrimmedString(raw.trigger),
		revertWhen: asTrimmedString(raw.revertWhen) || "the outer loop retires it",
	};
}

/**
 * Parse an outer-analysis payload, returning `null` when it is unusable.
 *
 * Upstream treats a parse failure as "change nothing": `_analyze` logs the failure and returns
 * a synthetic analysis carrying the *current* strategy and guidance. A malformed analyst reply
 * must never be able to reshape the search.
 */
export function parseOuterAnalysis(value: unknown): GoalOuterAnalysis | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const strategy = asTrimmedString(raw.strategy);
	const diagnosis = asTrimmedString(raw.diagnosis);
	const guidance = asTrimmedString(raw.guidance);
	if (!diagnosis && !guidance && !strategy) return null;
	return {
		diagnosis,
		// An unrecognized strategy is dropped here and defaulted by the caller against the
		// live config, matching upstream's `if new_strategy in (...)` whitelist check.
		strategy: strategy in GOAL_SEARCH_STRATEGIES ? (strategy as GoalSearchStrategy) : "explore",
		freezeApproaches: asStringList(raw.freezeApproaches),
		unfreezeApproaches: asStringList(raw.unfreezeApproaches),
		guidance,
		reasoning: asTrimmedString(raw.reasoning),
		mechanism: parseMechanism(raw.mechanism),
		retireMechanisms: asStringList(raw.retireMechanisms),
	};
}

function sameApproach(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/**
 * Apply an outer analysis to the Level 1.5 config in place and return the recorded cycle.
 *
 * Port of train_opt/outer.py `_apply_analysis`, preserving its guardrails: the strategy
 * whitelist, a per-cycle freeze cap (`MAX_FREEZE_PER_CYCLE`), and a bound that stops the outer
 * loop from freezing the search into a corner (upstream `MIN_ACTIVE_PARAMS` against a fixed
 * parameter list; here `MAX_FROZEN_APPROACHES` against an open-ended one).
 */
export function applyOuterAnalysis(
	state: GoalBilevelState,
	analysis: GoalOuterAnalysis,
	options: { stagnation?: string } = {},
): GoalOuterCycle {
	const config = state.config;
	config.strategy = analysis.strategy;

	const unfroze: string[] = [];
	for (const approach of analysis.unfreezeApproaches) {
		const index = config.frozenApproaches.findIndex(frozen => sameApproach(frozen, approach));
		if (index >= 0) {
			unfroze.push(config.frozenApproaches[index]!);
			config.frozenApproaches.splice(index, 1);
		}
	}

	const froze: string[] = [];
	for (const approach of analysis.freezeApproaches) {
		if (froze.length >= MAX_FREEZE_PER_CYCLE) break;
		if (config.frozenApproaches.length >= MAX_FROZEN_APPROACHES) break;
		if (config.frozenApproaches.some(frozen => sameApproach(frozen, approach))) continue;
		config.frozenApproaches.push(approach);
		froze.push(approach);
	}

	if (analysis.guidance) config.guidance = analysis.guidance;

	for (const name of analysis.retireMechanisms) {
		const index = config.mechanisms.findIndex(mechanism => sameApproach(mechanism.name, name));
		if (index >= 0) config.mechanisms.splice(index, 1);
	}

	let mechanismInstalled: string | undefined;
	const proposal = analysis.mechanism;
	if (proposal && !config.mechanisms.some(mechanism => sameApproach(mechanism.name, proposal.name))) {
		// Evict the oldest mechanism rather than refusing the new one: a stagnating loop needs
		// the freshest intervention, and an unbounded stack would crowd out the objective.
		if (config.mechanisms.length >= MAX_ACTIVE_MECHANISMS) config.mechanisms.shift();
		const mechanism: GoalMechanism = {
			name: proposal.name,
			trigger: proposal.trigger,
			intervention: proposal.intervention,
			revertWhen: proposal.revertWhen,
			installedAtIteration: state.iterationCount,
		};
		config.mechanisms.push(mechanism);
		mechanismInstalled = mechanism.name;
	}

	const cycle: GoalOuterCycle = {
		cycle: state.cycles.length + 1,
		atIteration: state.iterationCount,
		diagnosis: analysis.diagnosis,
		reasoning: analysis.reasoning,
		strategy: config.strategy,
		froze,
		unfroze,
		guidance: config.guidance,
		...(options.stagnation ? { stagnation: options.stagnation } : {}),
		...(mechanismInstalled ? { mechanismInstalled } : {}),
	};
	state.cycles.push(cycle);
	state.lastAnalyzedIteration = state.iterationCount;
	return cycle;
}
