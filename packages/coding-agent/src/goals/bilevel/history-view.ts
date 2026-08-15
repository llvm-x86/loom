import { escapeXmlText as esc } from "@oh-my-pi/pi-utils";
import type { Goal, GoalStatus } from "../state";
import type { GoalBilevelState, GoalIterationRecord, GoalOuterCycle } from "./state";

/** Model identity for one search level, formatted as `provider/id` (see `formatModelString`). */
export interface GoalHistoryModelInfo {
	inner: string;
	/** `undefined` when the goal is not running in bilevel mode. */
	outer?: string;
}

export interface GoalHistoryViewParams {
	goal: Goal;
	models: GoalHistoryModelInfo;
	bilevel?: GoalBilevelState;
}

function statusColor(status: GoalStatus): string {
	switch (status) {
		case "complete":
			return "#3fb950";
		case "dropped":
			return "#f85149";
		case "budget-limited":
			return "#d29922";
		case "paused":
			return "#8b949e";
		default:
			return "#58a6ff";
	}
}

function formatMs(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds - minutes * 60);
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function listOrDash(items: readonly string[]): string {
	return items.length > 0 ? esc(items.join(", ")) : '<span class="dim">—</span>';
}

function renderCycleRow(cycle: GoalOuterCycle): string {
	return `<tr>
		<td>${cycle.cycle}</td>
		<td>${cycle.atIteration}</td>
		<td><span class="pill pill-${esc(cycle.strategy)}">${esc(cycle.strategy)}</span></td>
		<td>${esc(cycle.diagnosis)}</td>
		<td>${esc(cycle.reasoning)}</td>
		<td>${listOrDash(cycle.froze)}</td>
		<td>${listOrDash(cycle.unfroze)}</td>
		<td>${cycle.guidance ? esc(cycle.guidance) : '<span class="dim">—</span>'}</td>
		<td>${cycle.stagnation ? `<span class="warn">${esc(cycle.stagnation)}</span>` : '<span class="dim">—</span>'}</td>
		<td>${cycle.mechanismInstalled ? esc(cycle.mechanismInstalled) : '<span class="dim">—</span>'}</td>
	</tr>`;
}

function renderIterationRow(record: GoalIterationRecord): string {
	return `<tr>
		<td>${record.iteration}</td>
		<td class="mono">${listOrDash(record.tools)}</td>
		<td class="mono">${record.failedTools.length > 0 ? `<span class="warn">${listOrDash(record.failedTools)}</span>` : '<span class="dim">—</span>'}</td>
		<td>${record.tokens.toLocaleString()}</td>
		<td>${formatMs(record.durationMs)}</td>
		<td class="mono dim">${esc(record.signature)}</td>
		<td>${record.goalToolUsed ? "✓" : ""}</td>
	</tr>`;
}

/**
 * Render a standalone, dependency-free HTML page showing a goal's search history: the outer
 * loop's cycle-by-cycle interventions and the inner loop's raw iteration trace. Written to a
 * temp file and opened via `openPath` — no live server, since the data is a point-in-time
 * snapshot the operator pulls on demand rather than something worth streaming.
 */
export function renderGoalHistoryHtml(params: GoalHistoryViewParams): string {
	const { goal, models, bilevel } = params;
	const mode = bilevel ? "Bilevel" : "Standard";
	const modelsLine = bilevel
		? `Inner loop: <code>${esc(models.inner)}</code> &nbsp;·&nbsp; Outer loop: <code>${esc(models.outer ?? models.inner)}</code>`
		: `Model: <code>${esc(models.inner)}</code>`;
	const tokensLine =
		goal.tokenBudget !== undefined
			? `${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens`
			: `${goal.tokensUsed.toLocaleString()} tokens (no budget)`;

	const cyclesSection = bilevel
		? bilevel.cycles.length > 0
			? `<h2>Outer loop — ${bilevel.cycles.length} cycle${bilevel.cycles.length === 1 ? "" : "s"}</h2>
				<table>
					<thead><tr>
						<th>Cycle</th><th>At iter.</th><th>Strategy</th><th>Diagnosis</th><th>Reasoning</th>
						<th>Froze</th><th>Unfroze</th><th>Guidance</th><th>Stagnation</th><th>Mechanism</th>
					</tr></thead>
					<tbody>${bilevel.cycles.map(renderCycleRow).join("\n")}</tbody>
				</table>`
			: `<h2>Outer loop</h2><p class="dim">No outer cycle has run yet (cadence: every ${bilevel.config.innerBudget} inner iterations).</p>`
		: "";

	const searchConfigSection = bilevel
		? `<h2>Current search configuration</h2>
			<table class="kv">
				<tr><th>Strategy</th><td><span class="pill pill-${esc(bilevel.config.strategy)}">${esc(bilevel.config.strategy)}</span></td></tr>
				<tr><th>Inner budget</th><td>${bilevel.config.innerBudget} iterations/cycle</td></tr>
				<tr><th>Frozen approaches</th><td>${listOrDash(bilevel.config.frozenApproaches)}</td></tr>
				<tr><th>Guidance</th><td>${bilevel.config.guidance ? esc(bilevel.config.guidance) : '<span class="dim">—</span>'}</td></tr>
				<tr><th>Active mechanisms</th><td>${
					bilevel.config.mechanisms.length > 0
						? bilevel.config.mechanisms
								.map(
									mechanism =>
										`<div class="mechanism"><strong>${esc(mechanism.name)}</strong> (since iter. ${mechanism.installedAtIteration})<br>` +
										`<span class="dim">trigger:</span> ${esc(mechanism.trigger)}<br>` +
										`<span class="dim">intervention:</span> ${esc(mechanism.intervention)}<br>` +
										`<span class="dim">revert when:</span> ${esc(mechanism.revertWhen)}</div>`,
								)
								.join("")
						: '<span class="dim">—</span>'
				}</td></tr>
			</table>`
		: "";

	const traceSection = bilevel
		? `<h2>Inner loop — ${bilevel.iterationCount} iteration${bilevel.iterationCount === 1 ? "" : "s"} total${
				bilevel.trace.length < bilevel.iterationCount ? ` (last ${bilevel.trace.length} shown)` : ""
			}</h2>
			${
				bilevel.trace.length > 0
					? `<table>
						<thead><tr><th>Iter.</th><th>Tools</th><th>Failed</th><th>Tokens</th><th>Duration</th><th>Signature</th><th>Goal tool</th></tr></thead>
						<tbody>${bilevel.trace.map(renderIterationRow).join("\n")}</tbody>
					</table>`
					: '<p class="dim">No iterations recorded yet.</p>'
			}`
		: "";

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Goal history — ${esc(goal.objective.slice(0, 60))}</title>
<style>
	:root { color-scheme: dark; }
	* { box-sizing: border-box; }
	body {
		margin: 0; padding: 32px 40px 64px;
		background: #0d1117; color: #c9d1d9;
		font: 14px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
	}
	h1 { font-size: 20px; margin: 0 0 4px; }
	h2 { font-size: 15px; margin: 32px 0 12px; color: #e6edf3; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
	.dim { color: #8b949e; }
	.warn { color: #d29922; }
	.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
	code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #161b22; padding: 1px 6px; border-radius: 4px; }
	.meta { color: #8b949e; margin: 2px 0; }
	.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; color: #0d1117; }
	.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: #21262d; }
	.pill-explore { background: #1f6feb33; color: #79c0ff; }
	.pill-exploit { background: #23863633; color: #7ee787; }
	.pill-focused { background: #8957e533; color: #d2a8ff; }
	table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
	table.kv th { width: 200px; }
	th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #21262d; vertical-align: top; }
	thead th { color: #8b949e; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
	tbody tr:hover { background: #161b22; }
	.mechanism { margin-bottom: 10px; }
	.mechanism:last-child { margin-bottom: 0; }
</style>
</head>
<body>
	<h1>${esc(goal.objective)}</h1>
	<p class="meta"><span class="badge" style="background:${statusColor(goal.status)}">${esc(goal.status)}</span>
		&nbsp; Mode: <strong>${mode}</strong> &nbsp;·&nbsp; ${tokensLine} &nbsp;·&nbsp; ${formatMs(goal.timeUsedSeconds * 1000)} spent</p>
	<p class="meta">${modelsLine}</p>
	${searchConfigSection}
	${cyclesSection}
	${traceSection}
</body>
</html>
`;
}
