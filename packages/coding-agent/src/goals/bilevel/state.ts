/**
 * Bilevel goal-mode state.
 *
 * Ports the control surface of Bilevel-Autoresearch (github.com/EdwardOptimization/Bilevel-Autoresearch)
 * onto loom's `/goal` loop:
 *
 * - Level 1 (inner loop)   = the existing hidden goal continuation. Optimizes WHAT to do.
 * - Level 1.5 (outer loop) = `GoalSearchConfig`, rewritten by an analyst LLM every
 *   `innerBudget` iterations. Optimizes HOW the inner loop searches.
 * - Level 2                = named mechanisms proposed when the inner loop stagnates.
 *
 * The upstream `SearchConfig` (domains/train_opt/config.py) exposes exactly five mutable
 * fields to the outer loop: `frozen_params`, `strategy`, `guidance`, `inner_budget`,
 * `time_budget`. The first three map directly; `innerBudget` is the cadence; the training
 * time budget has no analogue here because loom's goal budget is token-denominated and
 * user-owned.
 */

/**
 * Search strategy injected into the continuation prompt.
 *
 * Upstream whitelist is `explore | exploit | focused` (train_opt/outer.py `_apply_analysis`).
 * Anything outside the whitelist is discarded rather than trusted.
 */
export type GoalSearchStrategy = "explore" | "exploit" | "focused";

export const GOAL_SEARCH_STRATEGIES: Record<GoalSearchStrategy, true> = {
	explore: true,
	exploit: true,
	focused: true,
};

/** A Level 2 mechanism: a named, revertable intervention on the inner loop's process. */
export interface GoalMechanism {
	/** Stable identifier, e.g. `tabu-approach-memory`. */
	name: string;
	/** Observable condition that triggered this mechanism. */
	trigger: string;
	/** What the inner loop must do differently. Injected verbatim into the continuation prompt. */
	intervention: string;
	/** Observable condition under which the mechanism is retired. */
	revertWhen: string;
	/** Iteration index at which the mechanism was installed. */
	installedAtIteration: number;
}

/**
 * The Level 1.5 control surface. Only the outer loop writes this; the inner loop reads it
 * through the rendered continuation directive.
 */
export interface GoalSearchConfig {
	strategy: GoalSearchStrategy;
	/** Approaches the outer loop has ruled out. The inner loop must not retry them. */
	frozenApproaches: string[];
	/** Free-text process guidance injected into the continuation prompt. */
	guidance: string;
	/** Inner iterations between outer interventions. */
	innerBudget: number;
	/** Active Level 2 mechanisms. */
	mechanisms: GoalMechanism[];
}

/**
 * One inner-loop iteration, recorded at `agent_end`.
 *
 * This is the loom analogue of upstream `RunResult` (core/state.py) and it deliberately
 * carries **process signals only** — no file contents, no assistant text, no tool output.
 * Upstream enforces the same boundary in `extract_from_inner`, which archives inner content
 * but surfaces only process-level signals to the outer loop. Keeping that boundary is what
 * makes the outer loop optimize the *search* instead of quietly doing the task itself.
 */
export interface GoalIterationRecord {
	iteration: number;
	/** Tool names in call order. The observable proxy for "which dimension was searched". */
	tools: string[];
	/** Tool names that returned an error. Upstream analogue: `status: crash`. */
	failedTools: string[];
	/** Tokens attributed to this iteration. */
	tokens: number;
	/** Wall-clock milliseconds. */
	durationMs: number;
	/**
	 * Sorted, de-duplicated tool signature. Two iterations with an identical signature did
	 * the same *kind* of work; repeats without progress are the stagnation signal.
	 */
	signature: string;
	/** Whether the agent invoked the `goal` tool during this iteration without the goal ending. */
	goalToolUsed: boolean;
}

/** One outer-loop cycle, mirroring upstream `outer_trace` entries. */
export interface GoalOuterCycle {
	cycle: number;
	/** Iteration index at which the analysis ran. */
	atIteration: number;
	diagnosis: string;
	reasoning: string;
	strategy: GoalSearchStrategy;
	froze: string[];
	unfroze: string[];
	guidance: string;
	/** Set when the cycle was triggered by stagnation rather than plain cadence. */
	stagnation?: string;
	/** Name of the Level 2 mechanism installed by this cycle, if any. */
	mechanismInstalled?: string;
}

export interface GoalBilevelState {
	config: GoalSearchConfig;
	/** Bounded ring of recent iterations. */
	trace: GoalIterationRecord[];
	/** Completed outer cycles. */
	cycles: GoalOuterCycle[];
	/** Total iterations observed, including any evicted from `trace`. */
	iterationCount: number;
	/** Iteration index of the last outer analysis, so cadence survives persistence. */
	lastAnalyzedIteration: number;
}

/** Upstream default `inner_budget` is 5 (train_opt/config.py). */
export const DEFAULT_INNER_BUDGET = 5;

/** Retained iteration records. Bounds both persisted state and analyst prompt size. */
export const TRACE_CAPACITY = 40;

/**
 * Maximum approaches frozen in one cycle. Upstream `MAX_FREEZE_PER_CYCLE = 5`
 * (train_opt/outer.py `_apply_analysis`).
 */
export const MAX_FREEZE_PER_CYCLE = 5;

/**
 * Cap on total frozen approaches. Upstream instead guarantees `MIN_ACTIVE_PARAMS = 4`
 * against a fixed hyperparameter list; loom's approach space is open-ended, so the
 * equivalent protection against freezing the search into a corner is a ceiling on
 * exclusions (which also bounds the injected prompt).
 */
export const MAX_FROZEN_APPROACHES = 12;

/** Cap on simultaneously active Level 2 mechanisms. */
export const MAX_ACTIVE_MECHANISMS = 3;

/**
 * Retained outer cycles. Only the last two are ever read (the directive's diagnosis and the
 * iteration window it covers); the rest is history riding along in the session's mode entry.
 */
export const MAX_CYCLES = 12;

/**
 * Caps on analyst-authored text. Every string the outer loop writes is replayed into the inner
 * loop's prompt on every iteration until the next cycle rewrites it, so an analyst that answers
 * with an essay must not be able to crowd out the objective. Truncating beats dropping the
 * field: a clipped diagnosis still steers, a missing one silently disables the level.
 */
export const MAX_LABEL_CHARS = 200;
export const MAX_TEXT_CHARS = 1200;

/** Ceiling on list entries accepted from one analyst reply, before the per-cycle freeze cap. */
export const MAX_LIST_ENTRIES = 24;

/** Tool names retained per iteration record. A 200-call iteration must not become a 200-name line. */
export const MAX_ITERATION_TOOLS = 64;

export function defaultSearchConfig(innerBudget = DEFAULT_INNER_BUDGET): GoalSearchConfig {
	return { strategy: "explore", frozenApproaches: [], guidance: "", innerBudget, mechanisms: [] };
}

export function defaultBilevelState(innerBudget = DEFAULT_INNER_BUDGET): GoalBilevelState {
	return {
		config: defaultSearchConfig(innerBudget),
		trace: [],
		cycles: [],
		iterationCount: 0,
		lastAnalyzedIteration: 0,
	};
}

/**
 * Sorted, de-duplicated tool signature for an iteration.
 *
 * Order and repetition are dropped on purpose: two iterations that touched the same set of
 * tools did the same *kind* of work regardless of sequencing, which is what makes a repeat
 * detectable as stagnation rather than as progress.
 */
export function iterationSignature(tools: readonly string[]): string {
	if (tools.length === 0) return "(none)";
	return [...new Set(tools)].sort().join("+");
}

function stringList(value: unknown, limit: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		const trimmed = text(entry, MAX_LABEL_CHARS);
		if (trimmed) out.push(trimmed);
		if (out.length >= limit) break;
	}
	return out;
}

function text(value: unknown, limit = MAX_TEXT_CHARS): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function parseMechanism(value: unknown): GoalMechanism | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const name = text(raw.name, MAX_LABEL_CHARS);
	const intervention = text(raw.intervention);
	if (!name || !intervention) return undefined;
	return {
		name,
		trigger: text(raw.trigger, MAX_LABEL_CHARS),
		intervention,
		revertWhen: text(raw.revertWhen, MAX_LABEL_CHARS),
		installedAtIteration: Number.isInteger(raw.installedAtIteration) ? (raw.installedAtIteration as number) : 0,
	};
}

/**
 * Validate one persisted outer cycle. Cycles feed the analyst prompt and the rendered
 * directive, so a hand-edited session must not be able to smuggle an object of arbitrary
 * shape (or size) into either.
 */
function parseCycle(value: unknown, index: number): GoalOuterCycle | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const stagnation = text(raw.stagnation, MAX_LABEL_CHARS);
	const mechanismInstalled = text(raw.mechanismInstalled, MAX_LABEL_CHARS);
	return {
		cycle: Number.isInteger(raw.cycle) ? (raw.cycle as number) : index + 1,
		atIteration: Number.isInteger(raw.atIteration) ? (raw.atIteration as number) : 0,
		diagnosis: text(raw.diagnosis),
		reasoning: text(raw.reasoning),
		strategy:
			typeof raw.strategy === "string" && raw.strategy in GOAL_SEARCH_STRATEGIES
				? (raw.strategy as GoalSearchStrategy)
				: "explore",
		froze: stringList(raw.froze, MAX_FREEZE_PER_CYCLE),
		unfroze: stringList(raw.unfroze, MAX_FREEZE_PER_CYCLE),
		guidance: text(raw.guidance),
		...(stagnation ? { stagnation } : {}),
		...(mechanismInstalled ? { mechanismInstalled } : {}),
	};
}

/**
 * Rehydrate persisted bilevel state from session mode data.
 *
 * Session entries are on-disk JSON that may predate any field here, so every value is
 * re-validated and re-capped rather than trusted: a hand-edited or older session must not be
 * able to install an unbounded frozen list or an oversized trace.
 */
export function parseBilevelState(value: unknown, innerBudget = DEFAULT_INNER_BUDGET): GoalBilevelState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const rawConfig = (raw.config && typeof raw.config === "object" ? raw.config : {}) as Record<string, unknown>;
	const strategy = typeof rawConfig.strategy === "string" && rawConfig.strategy in GOAL_SEARCH_STRATEGIES;
	const mechanisms: GoalMechanism[] = [];
	if (Array.isArray(rawConfig.mechanisms)) {
		for (const entry of rawConfig.mechanisms) {
			const mechanism = parseMechanism(entry);
			if (mechanism) mechanisms.push(mechanism);
			if (mechanisms.length >= MAX_ACTIVE_MECHANISMS) break;
		}
	}
	const trace: GoalIterationRecord[] = [];
	if (Array.isArray(raw.trace)) {
		// Keep the newest window: the analyst reasons over recent iterations.
		for (const entry of raw.trace.slice(-TRACE_CAPACITY)) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			if (typeof record.iteration !== "number") continue;
			const tools = stringList(record.tools, MAX_ITERATION_TOOLS);
			trace.push({
				iteration: record.iteration,
				tools,
				failedTools: stringList(record.failedTools, MAX_ITERATION_TOOLS),
				tokens: typeof record.tokens === "number" ? record.tokens : 0,
				durationMs: typeof record.durationMs === "number" ? record.durationMs : 0,
				signature: typeof record.signature === "string" ? record.signature : iterationSignature(tools),
				goalToolUsed: record.goalToolUsed === true,
			});
		}
	}
	const iterationCount = typeof raw.iterationCount === "number" ? raw.iterationCount : (trace.at(-1)?.iteration ?? 0);
	const lastAnalyzed = typeof raw.lastAnalyzedIteration === "number" ? raw.lastAnalyzedIteration : 0;
	return {
		config: {
			strategy: strategy ? (rawConfig.strategy as GoalSearchStrategy) : "explore",
			frozenApproaches: stringList(rawConfig.frozenApproaches, MAX_FROZEN_APPROACHES),
			guidance: text(rawConfig.guidance),
			// A fractional cadence breaks the `iterationCount - lastAnalyzed >= innerBudget`
			// arithmetic into a loop that is due either always or never.
			innerBudget:
				Number.isInteger(rawConfig.innerBudget) && (rawConfig.innerBudget as number) > 0
					? (rawConfig.innerBudget as number)
					: innerBudget,
			mechanisms,
		},
		trace,
		cycles: Array.isArray(raw.cycles)
			? raw.cycles
					.slice(-MAX_CYCLES)
					.map((entry, index) => parseCycle(entry, index))
					.filter((cycle): cycle is GoalOuterCycle => cycle !== undefined)
			: [],
		iterationCount,
		// Clamp forward-dated markers so a corrupt value cannot suspend the outer loop forever.
		lastAnalyzedIteration: Math.min(Math.max(lastAnalyzed, 0), iterationCount),
	};
}
