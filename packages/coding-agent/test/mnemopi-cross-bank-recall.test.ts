/*
 * Cross-bank recall (read-only): an agent scoped to one project's mnemopi
 * bank can query ANOTHER project's bank by name, without disturbing its own
 * scoped recall/retain targets and without leaving the foreign handle open.
 *
 * Mirrors the setup in memory-tools.test.ts (TempDir-backed MnemopiBackendConfig,
 * noEmbeddings substring recall, registerMnemopiState-style session wiring) but
 * keeps its own module-local state so it can seed multiple sibling banks under
 * one shared data dir without fighting the other suite's globals.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MnemopiBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState, setMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { TempDir } from "@oh-my-pi/pi-utils";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

let tempDbDir: TempDir | undefined;
let tempDbPath: string | undefined;
const liveStates: MnemopiSessionState[] = [];

/** Narrow the tool result's first content block to its text, without asserting an unverified shape. */
function firstTextBlock(result: AgentToolResult): string {
	const block = result.content[0];
	if (!block || typeof block !== "object" || !("text" in block) || typeof block.text !== "string") {
		throw new Error(`expected a text content block, got: ${JSON.stringify(block)}`);
	}
	return block.text;
}


function makeConfig(overrides: Partial<MnemopiBackendConfig> = {}): MnemopiBackendConfig {
	if (!tempDbDir) {
		tempDbDir = TempDir.createSync(`@mnemopi-cross-bank-test-${Date.now()}-`);
		tempDbPath = tempDbDir.join("mnemopi.db");
	}
	return {
		dbPath: tempDbPath!,
		bank: "default",
		autoRecall: true,
		autoRetain: true,
		polyphonicRecall: false,
		enhancedRecall: false,
		treeEnabled: false,
		treeRoot: tempDbDir.join("tree"),
		treeLeafCharCap: 4096,
		treeEntryRows: 200,
		treeArchiveGcDays: 90,
		treeDedupe: true,
		wiki: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		providerOptions: {
			noEmbeddings: true,
			embeddingModel: undefined,
			embeddingApiUrl: undefined,
		},
		...overrides,
	} as MnemopiBackendConfig;
}

/** Build+register a session state for `bank`, seed it, and immediately dispose it — a sibling project's bank, not this test's "current" session. */
async function seedBank(bank: string, content: string, cwd = "/tmp"): Promise<void> {
	const config = makeConfig({ bank, retainBank: bank, recallBanks: [bank] });
	const state = registerState(config, `seed-${bank}`, cwd);
	state.rememberScoped(content, { source: "test", scope: "bank" });
	await state.dispose();
}

/** Build+register a session state that stays open for the duration of a test ("this session's own bank"). */
function registerState(config: MnemopiBackendConfig, sessionId: string, cwd = "/tmp"): MnemopiSessionState {
	const session = {
		sessionId,
		sessionManager: { getEntries: () => [], getCwd: () => cwd },
		emitNotice: () => {},
		getHindsightSessionState: () => undefined,
	} as never;
	const state = new MnemopiSessionState({ sessionId, config, session });
	setMnemopiSessionState(session, state);
	liveStates.push(state);
	return state;
}

function makeToolSession(state: MnemopiSessionState, settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionId: () => state.sessionId,
		getSessionSpawns: () => null,
		getHindsightSessionState: () => undefined,
		getMnemopiSessionState: () => state,
		awaitMnemopiSessionState: async () => state,
	} as unknown as ToolSession;
}

describe("cross-bank recall (Mnemopi backend)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		tempDbDir = undefined;
		tempDbPath = undefined;
		liveStates.length = 0;
	});

	afterEach(async () => {
		for (const state of liveStates.splice(0)) {
			await state.dispose().catch(() => {});
		}
		await tempDbDir?.remove();
		tempDbDir = undefined;
		tempDbPath = undefined;
	});

	it("recalls another bank's rows via repo param while own recall stays scoped to its own bank", async () => {
		await seedBank("team-beta", "beta project secret: uses Postgres for storage");
		const alpha = registerState(makeConfig({ bank: "team-alpha", retainBank: "team-alpha", recallBanks: ["team-alpha"] }), "alpha");
		alpha.rememberScoped("alpha project secret: uses SQLite for storage", { source: "test", scope: "bank" });

		const own = await alpha.recallResultsScoped("project secret storage");
		expect(own.some(r => r.content.includes("SQLite"))).toBe(true);
		expect(own.some(r => r.content.includes("Postgres"))).toBe(false);

		const cross = await alpha.recallFromBank("project secret storage", "team-beta");
		expect(cross.bank).toBe("team-beta");
		expect(cross.results.some(r => r.content.includes("Postgres"))).toBe(true);
		expect(cross.results.some(r => r.content.includes("SQLite"))).toBe(false);
	});

	it("owner/repo slug and its sanitized bank id resolve to the same bank", async () => {
		await seedBank("Family-Fun-Group-SkyRail", "skyrail project uses a Railway deploy target");
		const alpha = registerState(makeConfig({ bank: "team-alpha", retainBank: "team-alpha", recallBanks: ["team-alpha"] }), "alpha");

		const bySlug = await alpha.recallFromBank("deploy target", "Family-Fun-Group/SkyRail");
		const byBankId = await alpha.recallFromBank("deploy target", "Family-Fun-Group-SkyRail");
		expect(bySlug.bank).toBe("Family-Fun-Group-SkyRail");
		expect(byBankId.bank).toBe("Family-Fun-Group-SkyRail");
		expect(bySlug.results.map(r => r.content)).toEqual(byBankId.results.map(r => r.content));
		expect(bySlug.results.some(r => r.content.includes("Railway"))).toBe(true);
	});

	it("rejects an unknown bank with the available bank ids, not an empty result", async () => {
		await seedBank("team-beta", "beta fact");
		const alpha = registerState(makeConfig({ bank: "team-alpha", retainBank: "team-alpha", recallBanks: ["team-alpha"] }), "alpha");

		await expect(alpha.recallFromBank("anything", "no-such-project")).rejects.toThrow(/no such memory bank/i);
		await expect(alpha.recallFromBank("anything", "no-such-project")).rejects.toThrow(/team-beta/);
	});

	it("leaves the session's own scoped banks/retain target untouched and closes the foreign handle after a cross-bank recall", async () => {
		await seedBank("team-beta", "beta fact about deploys");
		const alpha = registerState(makeConfig({ bank: "team-alpha", retainBank: "team-alpha", recallBanks: ["team-alpha"] }), "alpha");
		const retainBefore = alpha.getScopedRetainTarget();
		const recallBefore = alpha.getScopedRecallTargets();

		await alpha.recallFromBank("deploys", "team-beta");

		expect(alpha.getScopedRetainTarget()).toBe(retainBefore);
		expect(alpha.getScopedRetainTarget().bank).toBe("team-alpha");
		expect(alpha.getScopedRecallTargets()).toEqual(recallBefore);
		expect(alpha.getScopedRecallTargets().map(t => t.bank)).toEqual(["team-alpha"]);
		// The foreign bank was never registered as a session-owned handle, so
		// disposing this session must not touch it (no double-close error).
		await expect(alpha.dispose()).resolves.toBeUndefined();
		liveStates.splice(liveStates.indexOf(alpha), 1);
	});

	it("lists seeded banks with row counts for discovery", async () => {
		await seedBank("team-beta", "beta fact one");
		await seedBank("Family-Fun-Group-SkyRail", "skyrail fact one");
		const alpha = registerState(makeConfig({ bank: "team-alpha", retainBank: "team-alpha", recallBanks: ["team-alpha"] }), "alpha");
		alpha.rememberScoped("alpha fact one", { source: "test", scope: "bank" });
		alpha.rememberScoped("alpha fact two", { source: "test", scope: "bank" });

		const banks = alpha.listAvailableBanks();
		const byId = new Map(banks.map(b => [b.bank, b]));
		expect(byId.get("team-alpha")).toMatchObject({ memories: 2, isOwnScope: true });
		expect(byId.get("team-beta")).toMatchObject({ memories: 1, isOwnScope: false });
		expect(byId.get("Family-Fun-Group-SkyRail")).toMatchObject({ memories: 1, isOwnScope: false });
	});

	it("recall tool: repo param and listBanks are reachable through execute()", async () => {
		await seedBank("team-beta", "beta fact about queues");
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		const alpha = registerState(makeConfig({ bank: "team-alpha", retainBank: "team-alpha", recallBanks: ["team-alpha"] }), "alpha");
		alpha.rememberScoped("alpha fact about queues", { source: "test", scope: "bank" });
		const session = makeToolSession(alpha, settings);
		const tool = new MemoryRecallTool(session);

		const crossResult = await tool.execute("call-cross", { query: "queues", repo: "team-beta" });
		const crossText = firstTextBlock(crossResult);
		expect(crossText).toContain('in bank "team-beta"');
		expect(crossText).toContain("queues");

		const listResult = await tool.execute("call-list", { listBanks: true });
		const listText = firstTextBlock(listResult);
		expect(listText).toContain("team-alpha");
		expect(listText).toContain("team-beta");
		expect(listText).toContain(alpha.config.treeRoot);
	});
});
