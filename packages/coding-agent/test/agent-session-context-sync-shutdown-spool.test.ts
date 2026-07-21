/**
 * Contracts: Context Activity shutdown handoff (`agent-session.ts` dispose).
 *
 * 1. `sessionContextSync.spoolDir` set -> dispose writes an atomic spool
 *    record under that dir and NEVER calls the model (no `runEphemeralTurn`,
 *    verified via the mock stream handler never firing).
 * 2. `syncContextCliMode: true` (the `loom sync-context` CLI's recursion
 *    guard) -> dispose writes NO spool file even though `spoolDir` is set,
 *    and still never calls the model.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession shutdown spool handoff", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelFileCounter = 0;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-shutdown-spool-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		settingsOverrides: Partial<Record<string, unknown>>,
		syncContextCliMode = false,
	): { session: AgentSession; streamCalls: () => number } {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const calls = { count: 0 };
		const mock = createMockModel({
			handler: () => {
				calls.count++;
				return { content: ["ok"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionDir = path.join(tempDir.path(), `sessions-${modelFileCounter}`);
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const settings = Settings.isolated({
			"sessionContextSync.enabled": true,
			"sessionContextSync.dir": path.join(tempDir.path(), "ledgers"),
			...settingsOverrides,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${modelFileCounter}.yml`)),
			agentId: "Main",
			syncContextCliMode,
		});
		modelFileCounter++;
		return { session, streamCalls: () => calls.count };
	}

	it("writes an atomic spool record and never calls the model when spoolDir is set", async () => {
		const spoolDir = path.join(tempDir.path(), "spool");
		const { session, streamCalls } = createSession({ "sessionContextSync.spoolDir": spoolDir });
		const sessionId = session.sessionId;

		await session.dispose();

		expect(streamCalls()).toBe(0);
		const entries = readdirSync(spoolDir).filter(name => name.endsWith(".json") && !name.includes(".tmp-"));
		expect(entries.length).toBe(1);
		expect(entries[0]).toStartWith(`${sessionId}-`);
		const record = JSON.parse(readFileSync(path.join(spoolDir, entries[0]), "utf8"));
		expect(record.sessionId).toBe(sessionId);
		expect(record.reason).toBe("shutdown");
		expect(typeof record.transcriptPath).toBe("string");
		expect(Array.isArray(record.repos)).toBe(true);
		expect(typeof record.createdAt).toBe("string");
	});

	it("skips both the spool write and the inline sync in syncContextCliMode (recursion guard)", async () => {
		const spoolDir = path.join(tempDir.path(), "spool");
		const { session, streamCalls } = createSession({ "sessionContextSync.spoolDir": spoolDir }, true);

		await session.dispose();

		expect(streamCalls()).toBe(0);
		expect(() => readdirSync(spoolDir)).toThrow();
	});
});
