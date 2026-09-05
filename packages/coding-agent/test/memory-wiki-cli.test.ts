import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	runMemoryWikiCommand,
	type WikiBankStatus,
	type WikiRunResult,
} from "@oh-my-pi/pi-coding-agent/cli/memory-wiki-cli";
import { RAW_MEMORY_TYPE, RAW_SOURCE, WikiStore } from "@oh-my-pi/pi-coding-agent/mnemopi/wiki";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const BANK = "testbank";
const SLUG = "deploy-success-live";

let root: string;
let writes: string[] = [];
let stderrWrites: string[] = [];
let stdoutSpy: { mockRestore(): void } | undefined;
let stderrSpy: { mockRestore(): void } | undefined;
let settingsState: SettingsTestState | undefined;
const originalExitCode = process.exitCode;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-wiki-"));
	// The skill proposer refuses to write outside `getAgentDir()`; point it at the temp root.
	setAgentDir(path.join(root, "agent"));
	writes = [];
	stderrWrites = [];
	process.exitCode = 0;
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
		writes.push(String(chunk));
		return true;
	});
	stderrSpy = spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderrWrites.push(String(chunk));
		return true;
	});
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	stderrSpy?.mockRestore();
	stderrSpy = undefined;
	process.exitCode = originalExitCode;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	await fs.rm(root, { recursive: true, force: true });
});

/** Store layout the CLI enumerates: `<store>/mnemopi.db` (default) + `<store>/banks/<id>/mnemopi.db`. */
function storeLocator() {
	return {
		dbPath: path.join(root, "store", "mnemopi.db"),
		providerOptions: { noEmbeddings: true, llm: false as const },
	};
}

function bankDbPath(): string {
	return path.join(root, "store", "banks", BANK, "mnemopi.db");
}

/**
 * Same fixture as `src/mnemopi/__tests__/wiki.test.ts`: one raw transcript row
 * per session id, each written by that session's own handle, plus one pattern
 * grounded in all of them.
 */
async function bankWithRawAndPattern(sessions: string[]): Promise<string[]> {
	const dbPath = bankDbPath();
	await fs.mkdir(path.dirname(dbPath), { recursive: true });
	const rawIds = sessions.map((sessionId, i) => {
		const lane = new Mnemopi({ dbPath, sessionId, bank: BANK, noEmbeddings: true });
		const id = lane.remember(`transcript ${i}: the deploy said success but the container was never replaced`, {
			source: RAW_SOURCE,
			memoryType: RAW_MEMORY_TYPE,
			importance: 0.5,
		});
		lane.close();
		return id;
	});
	const memory = new Mnemopi({ dbPath, sessionId: "lane-a", bank: BANK, noEmbeddings: true });
	new WikiStore(BANK, memory).createPattern({
		slug: "Deploy Success != Live",
		body: "PROBLEM deploy reports success while old container serves; ROOT CAUSE tag reuse; FIX compare container ctime.\n\nDetail.",
		evidence: rawIds,
	});
	memory.close();
	return rawIds;
}

function rowCount(): number {
	const db = new Database(bankDbPath(), { readonly: true });
	try {
		// bun:sqlite returns untyped rows; the query selects exactly one integer column.
		const row = db.query("SELECT count(*) AS n FROM working_memory").get() as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

function stdout(): string {
	return writes.join("");
}

describe("loom memory wiki", () => {
	test("status --json reports raw rows, patterns, recurrence and audit counts per bank", async () => {
		await bankWithRawAndPattern(["lane-a", "lane-b"]);
		await runMemoryWikiCommand(
			{ action: "status", flags: { json: true } },
			{ locator: storeLocator(), agentDir: path.join(root, "agent") },
		);
		const statuses = JSON.parse(stdout()) as WikiBankStatus[];
		// The default bank has no db file, so enumeration skips it rather than creating one.
		expect(statuses.map(s => s.bank)).toEqual([BANK]);
		expect(statuses[0]).toEqual({
			bank: BANK,
			rawRows: 2,
			patterns: 1,
			lastPassAt: null,
			recurringPatterns: 1,
			skillsCited: [],
			rejectedProposals: 0,
		});
		expect(await fs.exists(path.join(root, "store", "mnemopi.db"))).toBe(false);
	});

	test("index prints the wiki index containing the pattern slug", async () => {
		await bankWithRawAndPattern(["lane-a"]);
		await runMemoryWikiCommand(
			{ action: "index", flags: { bank: BANK } },
			{ locator: storeLocator(), agentDir: path.join(root, "agent") },
		);
		expect(stdout()).toContain(`[${SLUG}](wiki/patterns/${SLUG}.md)`);
		expect(stdout()).toContain("1 rows, 1 sessions");
	});

	test("log and impact render the empty-state placeholders before any pass", async () => {
		await bankWithRawAndPattern(["lane-a"]);
		const runtime = { locator: storeLocator(), agentDir: path.join(root, "agent") };
		await runMemoryWikiCommand({ action: "log", flags: { limit: 5 } }, runtime);
		expect(stdout()).toContain("(no passes yet)");
		writes = [];
		await runMemoryWikiCommand({ action: "impact", flags: {} }, runtime);
		expect(stdout()).toContain("(no skill proposals yet)");
	});

	test("run --dry-run prints the prompts, reports a skipped pass and writes zero rows", async () => {
		await bankWithRawAndPattern(["lane-a", "lane-b"]);
		const before = rowCount();
		await runMemoryWikiCommand(
			{ action: "run", flags: { dryRun: true, skills: true, json: true } },
			{ locator: storeLocator(), agentDir: path.join(root, "agent") },
		);
		const out = stdout();
		// Both the maintainer and the proposer prompts reach the recording fake.
		const prompts = out.split(`--- prompt (${BANK}) ---`).length - 1;
		expect(prompts).toBe(2);
		expect(out).toContain(SLUG);
		const jsonStart = out.lastIndexOf("\n[");
		const results = JSON.parse(out.slice(jsonStart)) as WikiRunResult[];
		expect(results).toHaveLength(1);
		expect(results[0]?.bank).toBe(BANK);
		expect(results[0]?.dryRun).toBe(true);
		// A null completion is malformed output: nothing accepted, nothing written.
		expect(results[0]?.maintainer.skipped).toBe("malformed-output");
		expect(results[0]?.maintainer.accepted).toBe(0);
		expect(results[0]?.skills?.skipped).toBe("malformed-output");
		expect(results[0]?.skills?.action).toBe("no_action");
		expect(rowCount()).toBe(before);
		expect(await fs.exists(path.join(root, "agent", "managed-skills"))).toBe(false);
	});

	test("an unknown --bank fails with a clear error and exit code 1", async () => {
		await bankWithRawAndPattern(["lane-a"]);
		await runMemoryWikiCommand(
			{ action: "status", flags: { bank: "nope" } },
			{ locator: storeLocator(), agentDir: path.join(root, "agent") },
		);
		expect(stderrWrites.join("")).toContain('No memory database found for bank "nope"');
		expect(process.exitCode).toBe(1);
		expect(stdout()).toBe("");
	});
});
