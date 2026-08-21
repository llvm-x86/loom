/**
 * Resident agents — long-lived, stably named subagents that preserve context
 * across invocations.
 *
 * Design (see AgentDefinition.resident):
 * - The transcript is a CACHE: parked sessions cold-revive with full
 *   conversation state, so a woken resident remembers recent work verbatim.
 *   Auto-compaction applies to resident sessions exactly as to any other.
 * - The per-resident memory bank is the DATABASE: `mnemopi.bank` is scoped to
 *   `resident-<agent>` per project, so distilled knowledge (bug signatures,
 *   rejected approaches, invariants) survives compaction, reset, and process
 *   restarts. Persona prompts are responsible for the retain/recall
 *   discipline; this module only guarantees the stable scope.
 * - Transcripts live in `<projectSessionDir>/residents/<Id>.jsonl` so they
 *   are discoverable by ANY session of the project, not just the one that
 *   first spawned the resident.
 * - Cross-process split-brain is prevented by an ownership file
 *   (`<Id>.jsonl.owner` = {pid, ts}); a live foreign owner makes routing and
 *   fresh spawns refuse rather than double-attach to one transcript. Stale
 *   owners (dead pid) are reclaimed.
 *
 * Routing: a spawn request for a resident persona first tries to wake the
 * existing instance (IRC bus send with expectsReply + bounded wait for the
 * hub reply). Absent, aborted, foreign-owned, or undeliverable residents
 * degrade to a fresh spawn — the bank keeps knowledge continuity even when
 * the transcript cache is lost.
 *
 * Known limitation: two concurrent in-flight routings to the same resident
 * from one Main can cross-wire replies (bus waits filter by sender only).
 * The task tool's spawn semaphore makes this rare in practice.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";

export const RESIDENTS_DIR_NAME = "residents";

/** "bug-reviewer" → "BugReviewer" — stable, display-friendly registry id. */
export function residentIdForAgent(agentName: string): string {
	return agentName
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(part => part[0]!.toUpperCase() + part.slice(1))
		.join("");
}

/** Stable per-project memory-bank scope for a resident persona. */
export function residentBankName(agentName: string): string {
	return `resident-${agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** `<projectSessionDir>/residents` for a persisted session, null when in-memory. */
export function residentsDirForSessionFile(sessionFile: string | null | undefined): string | null {
	if (!sessionFile?.endsWith(".jsonl")) return null;
	return path.join(path.dirname(sessionFile), RESIDENTS_DIR_NAME);
}

export function residentTranscriptPath(sessionFile: string | null | undefined, id: string): string | null {
	const dir = residentsDirForSessionFile(sessionFile);
	return dir ? path.join(dir, `${id}.jsonl`) : null;
}

export interface ResidentOwner {
	pid: number;
	ts: number;
}

function ownerPathFor(transcriptPath: string): string {
	return `${transcriptPath}.owner`;
}

function isPidAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user — alive.
		// ESRCH: no such process — dead. Anything else: assume dead.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readOwner(transcriptPath: string): Promise<ResidentOwner | null> {
	try {
		const raw = await fs.readFile(ownerPathFor(transcriptPath), "utf-8");
		const parsed = JSON.parse(raw) as Partial<ResidentOwner>;
		return typeof parsed.pid === "number" ? { pid: parsed.pid, ts: Number(parsed.ts) || 0 } : null;
	} catch {
		return null;
	}
}

/** Owner record for a resident transcript, or null when unowned/unreadable. */
export function readResidentOwner(transcriptPath: string): Promise<ResidentOwner | null> {
	return readOwner(transcriptPath);
}

export type ResidentOwnership = "ours" | "claimed" | "foreign" | "stale-reclaimed";

/**
 * Claim exclusive ownership of a resident transcript for this process.
 * Returns "foreign" (and claims nothing) when another LIVE process owns it;
 * dead-owner files are reclaimed. Ownership is advisory and pid-based — no
 * release needed on exit, staleness handles crashes.
 */
export async function claimResidentOwnership(transcriptPath: string): Promise<ResidentOwnership> {
	const existing = await readOwner(transcriptPath);
	if (existing) {
		if (existing.pid === process.pid) return "ours";
		if (isPidAlive(existing.pid)) return "foreign";
	}
	try {
		await Bun.write(ownerPathFor(transcriptPath), JSON.stringify({ pid: process.pid, ts: Date.now() }));
		return existing ? "stale-reclaimed" : "claimed";
	} catch (error) {
		logger.warn("Failed to write resident ownership file", { transcriptPath, error });
		// Ownership is a guard, not the mechanism: failing to WRITE the guard
		// must not block a resident from running in this process.
		return "claimed";
	}
}

/** True when a LIVE foreign process owns this resident transcript. */
export async function isResidentForeignOwned(transcriptPath: string): Promise<boolean> {
	const owner = await readOwner(transcriptPath);
	return owner !== null && owner.pid !== process.pid && isPidAlive(owner.pid);
}

/** Remove transcript + ownership file. Returns true when anything was removed. */
export async function deleteResidentTranscript(transcriptPath: string): Promise<boolean> {
	let removed = false;
	for (const target of [transcriptPath, ownerPathFor(transcriptPath)]) {
		// fs.rm(force) swallows ENOENT, which would make the return value
		// meaningless — stat first so "removed" means "was there, now gone".
		const exists = (await fs.stat(target).catch(() => null)) !== null;
		if (!exists) continue;
		try {
			await fs.rm(target, { force: true });
			removed = true;
		} catch (error) {
			if (!isEnoent(error)) logger.warn("Failed to remove resident artifact", { target, error });
		}
	}
	return removed;
}

const registeredResidentDirs = new Set<string>();

/**
 * Register every persisted resident transcript as a parked registry ref so
 * routing/hub can cold-revive it. Idempotent per residents dir per process.
 * Mirrors registerPersistedSubagents but scans the STABLE per-project
 * residents dir instead of a single session's transcript dir.
 */
export async function registerPersistedResidents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
): Promise<void> {
	const dir = residentsDirForSessionFile(sessionFile);
	if (!dir || registeredResidentDirs.has(dir)) return;
	registeredResidentDirs.add(dir);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Failed to scan residents dir", { dir, error });
		return;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const id = entry.slice(0, -".jsonl".length);
		if (registry.get(id)) continue;
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: path.join(dir, entry),
			status: "parked",
		});
	}
}

/** Test-only: reset the per-process registration memo. */
export function __resetResidentRegistrationForTesting(): void {
	registeredResidentDirs.clear();
}

export type ResidentRouteOutcome =
	| { kind: "reply"; body: string; revived: boolean }
	| { kind: "absent" }
	| { kind: "foreign-owned" }
	| { kind: "timeout"; waitedMs: number };

/** Default upper bound on a routed resident turn when no setting overrides it. */
export const RESIDENT_ROUTE_DEFAULT_TIMEOUT_MS = 30 * 60_000;

const RESIDENT_TASK_PREAMBLE =
	"You are being invoked as a resident agent. Work the task below, then send your COMPLETE result " +
	`back with the hub tool (send to "${MAIN_AGENT_ID}") before going idle — the caller is blocked ` +
	"waiting on that reply. Do not answer with yield alone.\n\n";

/**
 * Wake-or-fail routing to an existing resident: deliver the task to the
 * live/parked instance (cold-reviving through the lifecycle when parked) and
 * await its hub reply. Returns "absent" when no usable resident exists — the
 * caller falls back to a fresh spawn (the memory bank preserves continuity).
 */
export async function routeToResident(args: {
	registry: AgentRegistry;
	id: string;
	task: string;
	sessionFile: string | null | undefined;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<ResidentRouteOutcome> {
	const { registry, id, task, signal } = args;
	const timeoutMs = Math.max(1, Math.trunc(args.timeoutMs ?? RESIDENT_ROUTE_DEFAULT_TIMEOUT_MS));
	await registerPersistedResidents(registry, args.sessionFile);
	const ref = registry.get(id);
	if (!ref || ref.status === "aborted" || ref.kind === "advisor") return { kind: "absent" };
	const transcriptPath = ref.sessionFile ?? residentTranscriptPath(args.sessionFile, id);
	if (transcriptPath && (await isResidentForeignOwned(transcriptPath))) return { kind: "foreign-owned" };

	const bus = IrcBus.global();
	const receipt = await bus.send(
		{ from: MAIN_AGENT_ID, to: id, body: `${RESIDENT_TASK_PREAMBLE}${task}` },
		{ expectsReply: true },
	);
	if (receipt.outcome === "failed") {
		// Graceful degradation: an unroutable resident (dead registry ref, failed
		// revive) falls back to a fresh spawn rather than failing the task.
		logger.warn("Resident route failed; falling back to fresh spawn", { id, error: receipt.error });
		return { kind: "absent" };
	}
	const startedAt = Date.now();
	const reply = await bus.wait(MAIN_AGENT_ID, { from: id }, timeoutMs, signal);
	if (!reply) return { kind: "timeout", waitedMs: Date.now() - startedAt };
	return { kind: "reply", body: reply.body, revived: receipt.outcome === "revived" };
}

/** Lifecycle/registry accessors bundled for slash-command use. */
export function residentRuntime() {
	return {
		registry: AgentRegistry.global(),
		lifecycle: AgentLifecycleManager.global(),
		bus: IrcBus.global(),
	};
}
