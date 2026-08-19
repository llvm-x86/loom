/*
 * Coverage for the mnemopi store-health path: classifying an unwritable-store
 * startup failure, surfacing an actionable error at the `memory`/`recall`
 * tool call sites (instead of the misleading "not initialised" message), and
 * the bounded, throttled retry that lets a live session recover once the
 * operator fixes the sandbox — without a session restart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { retryMnemopiStartupIfDue } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import {
	classifyMnemopiStartupFailure,
	formatMnemopiStartupFailureMessage,
	getMnemopiSessionState,
	getMnemopiStartupFailure,
	loadMnemopi,
	loadMnemopiCore,
	type MnemopiStartupFailure,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryTool } from "@oh-my-pi/pi-coding-agent/tools/memory-tool";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it so the sync `new Mnemopi(...)`
// inside a real startup attempt can resolve the module.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const isRoot = process.getuid?.() === 0;

// A fake ModelRegistry that never hits the network: `mnemopi.llmMode` is
// forced to "none" below, so `resolveMnemopiProviderOptions` only ever needs
// `getApiKeyForProvider` (for the embedding-key lookup, which is skipped when
// `embeddingApiUrl` is unset and returns undefined here regardless).
function fakeModelRegistry(): ModelRegistry {
	return { getApiKeyForProvider: async () => undefined } as unknown as ModelRegistry;
}

function fakeAgentSession(sessionId: string, emitNotice: (...args: unknown[]) => void = () => {}): AgentSession {
	return {
		sessionId,
		subscribe: () => () => {},
		emitNotice,
		sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
		messages: [],
	} as unknown as AgentSession;
}

describe("classifyMnemopiStartupFailure", () => {
	it("classifies a SQLite readonly-database error as store-not-writable", () => {
		const result = classifyMnemopiStartupFailure(
			new Error("SqliteError: attempt to write a readonly database"),
		);
		expect(result.kind).toBe("store-not-writable");
		expect(result.detail).toContain("readonly database");
	});

	it("classifies error.code SQLITE_READONLY as store-not-writable", () => {
		const err = Object.assign(new Error("write failed"), { code: "SQLITE_READONLY" });
		const result = classifyMnemopiStartupFailure(err);
		expect(result.kind).toBe("store-not-writable");
		expect(result.code).toBe("SQLITE_READONLY");
	});

	it("classifies EROFS via error.code and extracts the quoted path", () => {
		const err = Object.assign(
			new Error("EROFS: read-only file system, mkdir '/var/lib/agent-memory/mnemopi/banks/foo'"),
			{ code: "EROFS" },
		);
		const result = classifyMnemopiStartupFailure(err);
		expect(result.kind).toBe("store-not-writable");
		expect(result.code).toBe("EROFS");
		expect(result.path).toBe("/var/lib/agent-memory/mnemopi/banks/foo");
		expect(result.detail).toBe("EROFS: /var/lib/agent-memory/mnemopi/banks/foo");
	});

	it("classifies EACCES/EPERM found only in the message text (no error.code)", () => {
		const acces = classifyMnemopiStartupFailure(new Error("mkdir failed: EACCES permission denied"));
		expect(acces.kind).toBe("store-not-writable");
		expect(acces.code).toBe("EACCES");

		const eperm = classifyMnemopiStartupFailure(new Error("open failed: EPERM operation not permitted"));
		expect(eperm.kind).toBe("store-not-writable");
		expect(eperm.code).toBe("EPERM");
	});

	it("classifies an unrelated error as unknown", () => {
		const result = classifyMnemopiStartupFailure(new Error("model registry unavailable"));
		expect(result.kind).toBe("unknown");
		expect(result.detail).toBe("model registry unavailable");
		expect(result.code).toBeUndefined();
		expect(result.path).toBeUndefined();
	});

	it("handles non-Error thrown values", () => {
		const result = classifyMnemopiStartupFailure("just a string, EROFS somewhere");
		expect(result.kind).toBe("store-not-writable");
		expect(result.code).toBe("EROFS");
	});
});

describe("formatMnemopiStartupFailureMessage", () => {
	it("produces an operator-actionable message for store-not-writable, distinct from 'not initialised'", () => {
		const message = formatMnemopiStartupFailureMessage({
			kind: "store-not-writable",
			code: "EROFS",
			path: "/var/lib/agent-memory/mnemopi/banks",
			detail: "EROFS: /var/lib/agent-memory/mnemopi/banks",
			recordedAt: Date.now(),
		});
		expect(message).toContain("not writable");
		expect(message).toContain("EROFS: /var/lib/agent-memory/mnemopi/banks");
		expect(message).toContain("operator/filesystem issue");
		expect(message).not.toContain("not initialised");
	});

	it("produces a distinct message for an unknown failure", () => {
		const message = formatMnemopiStartupFailureMessage({
			kind: "unknown",
			detail: "boom",
			recordedAt: Date.now(),
		});
		expect(message).toContain("failed to start");
		expect(message).toContain("boom");
	});
});

describe("memory/recall tool call sites surface the classified failure", () => {
	function makeToolSession(startupFailure: MnemopiStartupFailure | undefined): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "memory.backend": "mnemopi" }),
			getSessionFile: () => null,
			getSessionId: () => "test-session-id",
			getSessionSpawns: () => null,
			getMnemopiSessionState: () => undefined,
			awaitMnemopiSessionState: async () => undefined,
			getMnemopiStartupFailure: () => startupFailure,
		} as unknown as ToolSession;
	}

	beforeEach(() => resetSettingsForTest());

	it("memory tool throws the actionable message when a store-not-writable failure is on record", async () => {
		const session = makeToolSession({
			kind: "store-not-writable",
			code: "EROFS",
			path: "/var/lib/agent-memory/mnemopi/banks",
			detail: "EROFS: /var/lib/agent-memory/mnemopi/banks",
			recordedAt: Date.now(),
		});
		const tool = MemoryTool.createIf(session)!;
		await expect(tool.execute("call-1", { action: "add", content: "hello" })).rejects.toThrow(
			/not writable.*EROFS: \/var\/lib\/agent-memory\/mnemopi\/banks/s,
		);
	});

	it("recall tool throws the actionable message when a store-not-writable failure is on record", async () => {
		const session = makeToolSession({
			kind: "store-not-writable",
			code: "EROFS",
			path: "/var/lib/agent-memory/mnemopi/banks",
			detail: "EROFS: /var/lib/agent-memory/mnemopi/banks",
			recordedAt: Date.now(),
		});
		const tool = MemoryRecallTool.createIf(session)!;
		await expect(tool.execute("call-1", { query: "anything" })).rejects.toThrow(/not writable/);
	});

	it("falls back to the generic 'not initialised' message when there is no recorded failure (genuine not-yet-started case)", async () => {
		const session = makeToolSession(undefined);
		const tool = MemoryTool.createIf(session)!;
		await expect(tool.execute("call-1", { action: "add", content: "hello" })).rejects.toThrow(
			"Mnemopi backend is not initialised for this session.",
		);
	});
});

describe("mnemopi backend startup: unwritable store is non-fatal and recoverable", () => {
	let readonlyDir: TempDir | undefined;
	let sessionId: string;

	beforeEach(() => {
		resetSettingsForTest();
		sessionId = `store-health-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetMemoryForTests();
		if (readonlyDir) {
			// Restore write perms before TempDir tries to remove it.
			await chmod(readonlyDir.path(), 0o700).catch(() => {});
			await readonlyDir.remove();
			readonlyDir = undefined;
		}
	});

	it.skipIf(isRoot)(
		"start() never throws on an unwritable store, records a classified failure, and emits exactly one notice",
		async () => {
			readonlyDir = TempDir.createSync("@mnemopi-store-health-");
			const dbDir = path.join(readonlyDir.path(), "sealed");
			await mkdir(dbDir, { recursive: true });
			await chmod(dbDir, 0o500);

			const settings = Settings.isolated({
				"mnemopi.dbPath": path.join(dbDir, "banks", "mnemopi.db"),
				"mnemopi.llmMode": "none",
			});
			const emitNotice = vi.fn();
			const session = fakeAgentSession(sessionId, emitNotice);

			await expect(
				mnemopiBackend.start({
					session,
					settings,
					modelRegistry: fakeModelRegistry(),
					agentDir: readonlyDir.path(),
					taskDepth: 0,
				}),
			).resolves.toBeUndefined();

			expect(getMnemopiSessionState(session)).toBeUndefined();
			const failure = getMnemopiStartupFailure(session);
			expect(failure?.kind).toBe("store-not-writable");
			expect(emitNotice).toHaveBeenCalledTimes(1);
			expect(emitNotice.mock.calls[0]?.[0]).toBe("error");
			expect(String(emitNotice.mock.calls[0]?.[1])).toContain("not writable");

			// A second attempt through the exact same path must not re-emit —
			// the notice is once-per-session, not once-per-attempt.
			await mnemopiBackend.start({
				session,
				settings,
				modelRegistry: fakeModelRegistry(),
				agentDir: readonlyDir.path(),
				taskDepth: 0,
			});
			expect(emitNotice).toHaveBeenCalledTimes(1);
		},
	);

	it.skipIf(isRoot)(
		"retryMnemopiStartupIfDue throttles to at most one attempt per interval, then recovers once the store is fixed",
		async () => {
			readonlyDir = TempDir.createSync("@mnemopi-store-health-retry-");
			const dbDir = path.join(readonlyDir.path(), "sealed");
			await mkdir(dbDir, { recursive: true });
			await chmod(dbDir, 0o500);

			const settings = Settings.isolated({
				"mnemopi.dbPath": path.join(dbDir, "banks", "mnemopi.db"),
				"mnemopi.llmMode": "none",
			});
			const session = fakeAgentSession(sessionId);

			// Initial start fails: the store is sealed.
			await mnemopiBackend.start({
				session,
				settings,
				modelRegistry: fakeModelRegistry(),
				agentDir: readonlyDir.path(),
				taskDepth: 0,
			});
			expect(getMnemopiSessionState(session)).toBeUndefined();

			// Call-counting fake: count real startup attempts via a spy on
			// `settings.get`, which `loadMnemopiConfig` calls dozens of times per
			// attempt and never otherwise. A rising count is proof an attempt ran;
			// an unchanged count is proof one was throttled — no wall-clock sleep.
			const getSpy = vi.spyOn(settings, "get");
			const callsBefore = getSpy.mock.calls.length;

			// First retry: no prior retry attempt recorded, so it's allowed even
			// though the store is still sealed — it fails again, but it DID attempt.
			const r1 = await retryMnemopiStartupIfDue(session, { now: () => 1_000, intervalMs: 60_000 });
			expect(r1).toBeUndefined();
			const callsAfterFirst = getSpy.mock.calls.length;
			expect(callsAfterFirst).toBeGreaterThan(callsBefore);

			// Fix the store, then retry again inside the throttle window: must be
			// throttled (no new attempt), so it must NOT pick up the fix yet.
			await chmod(dbDir, 0o700);
			const r2 = await retryMnemopiStartupIfDue(session, { now: () => 1_500, intervalMs: 60_000 });
			expect(r2).toBeUndefined();
			expect(getMnemopiSessionState(session)).toBeUndefined();
			const callsAfterSecond = getSpy.mock.calls.length;
			expect(callsAfterSecond).toBe(callsAfterFirst);

			// Past the throttle window: a new attempt runs, and now that the store
			// is writable, the session recovers fully — no restart required.
			const r3 = await retryMnemopiStartupIfDue(session, { now: () => 1_000 + 61_000, intervalMs: 60_000 });
			expect(r3).toBeDefined();
			expect(getMnemopiSessionState(session)).toBe(r3);
			expect(getMnemopiStartupFailure(session)).toBeUndefined();
			const callsAfterThird = getSpy.mock.calls.length;
			expect(callsAfterThird).toBeGreaterThan(callsAfterSecond);

			await r3?.dispose();
		},
	);

	it("retryMnemopiStartupIfDue is a no-op when there is no recorded store-not-writable failure", async () => {
		const settings = Settings.isolated({ "mnemopi.llmMode": "none" });
		const session = fakeAgentSession(sessionId);
		void settings;
		const result = await retryMnemopiStartupIfDue(session, { now: () => 0, intervalMs: 60_000 });
		expect(result).toBeUndefined();
	});
});
