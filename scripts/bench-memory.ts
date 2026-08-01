#!/usr/bin/env bun
/**
 * Memory benchmark harness.
 *
 * Reports peak/steady RSS for the phases that dominate loom's footprint, so
 * memory-reduction changes can be measured instead of asserted.
 *
 * Usage:
 *   bun scripts/bench-memory.ts                      # startup-graph phases only
 *   bun scripts/bench-memory.ts <session.jsonl>      # + session-load phases
 *
 * Each phase runs in a fresh subprocess: module-load costs are one-shot and
 * would otherwise be attributed to whichever phase happened to run first.
 */
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

interface Phase {
	readonly name: string;
	/** Body evaluated by `bun -e` in a fresh process, cwd = repo root. */
	readonly code: string;
}

const RSS = `console.log(JSON.stringify({rss: process.memoryUsage.rss()}))`;

function startupPhases(): Phase[] {
	return [
		{ name: "bun-baseline", code: RSS },
		{ name: "natives", code: `await import("@oh-my-pi/pi-natives");${RSS}` },
		{ name: "arktype", code: `await import("arktype");${RSS}` },
		{ name: "catalog-models", code: `await import("@oh-my-pi/pi-catalog/models");${RSS}` },
		{ name: "catalog", code: `await import("@oh-my-pi/pi-catalog");${RSS}` },
		{ name: "ai", code: `await import("@oh-my-pi/pi-ai");${RSS}` },
		{ name: "tui", code: `await import("@oh-my-pi/pi-tui");${RSS}` },
		{ name: "coding-agent", code: `await import("@oh-my-pi/pi-coding-agent");${RSS}` },
	];
}

function sessionPhases(sessionFile: string): Phase[] {
	const f = JSON.stringify(sessionFile);
	return [
		{
			name: "session-entries",
			code: `const {loadEntriesFromFile}=await import("./packages/coding-agent/src/session/session-loader.ts");
const e=await loadEntriesFromFile(${f});
globalThis.__keep=e;
console.log(JSON.stringify({rss:process.memoryUsage.rss(),entries:e.length}));`,
		},
		{
			name: "session-messages",
			code: `const {loadSessionMessagesReadOnly}=await import("./packages/coding-agent/src/session/session-loader.ts");
const m=await loadSessionMessagesReadOnly(${f});
globalThis.__keep=m;
console.log(JSON.stringify({rss:process.memoryUsage.rss(),messages:m.length}));`,
		},
	];
}

interface Result {
	readonly name: string;
	/** Steady RSS reported from inside the process, bytes. */
	readonly rss: number;
	/** Peak RSS observed by the kernel, bytes. */
	readonly peak: number;
	readonly extra: Record<string, number>;
}

async function runPhase(phase: Phase): Promise<Result> {
	// `/usr/bin/time -f %M` gives kernel-observed peak RSS in KiB; the in-process
	// number alone misses transient spikes (parse buffers, structuredClone).
	const proc = Bun.spawnSync(["/usr/bin/time", "-f", "PEAK_KB=%M", "bun", "-e", phase.code], {
		cwd: repoRoot,
		env: { ...Bun.env, NO_COLOR: "1" },
	});
	const stdout = proc.stdout.toString();
	const stderr = proc.stderr.toString();
	const peakMatch = stderr.match(/PEAK_KB=(\d+)/);
	if (proc.exitCode !== 0 || !peakMatch) {
		throw new Error(`phase ${phase.name} failed (exit ${proc.exitCode}):\n${stderr.slice(0, 2000)}`);
	}
	const line = stdout.trim().split("\n").at(-1);
	if (!line) throw new Error(`phase ${phase.name} produced no measurement`);
	const parsed: Record<string, number> = JSON.parse(line);
	const { rss, ...extra } = parsed;
	return { name: phase.name, rss, peak: Number(peakMatch[1]) * 1024, extra };
}

function mib(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1).padStart(7);
}

async function main(): Promise<void> {
	const sessionFile = Bun.argv[2];
	const phases = sessionFile ? [...startupPhases(), ...sessionPhases(sessionFile)] : startupPhases();

	const results: Result[] = [];
	for (const phase of phases) results.push(await runPhase(phase));

	const baseline = results[0]?.rss ?? 0;
	console.log("phase                      rss MiB   peak MiB   delta-vs-baseline");
	for (const r of results) {
		const extra = Object.entries(r.extra)
			.map(([k, v]) => ` ${k}=${v}`)
			.join("");
		console.log(`${r.name.padEnd(24)} ${mib(r.rss)}   ${mib(r.peak)}   ${mib(r.rss - baseline)}${extra}`);
	}
	console.log(`\nJSON: ${JSON.stringify(results)}`);
}

await main();
