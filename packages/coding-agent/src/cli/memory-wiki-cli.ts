/**
 * CLI handler for `loom memory wiki` — inspect and manually run the wiki layer
 * (compiled patterns over raw mnemopi rows; design in `../mnemopi/wiki.ts`).
 *
 * Read-only subcommands (`status`, `index`, `log`, `impact`) open each bank
 * the way `MnemopiSessionState` opens a foreign bank for cross-bank recall:
 * `reconcile: false`, so a stats read never kicks off the embedding-model
 * wipe-and-rebuild that a short-lived CLI process would exit before finishing.
 * `run` keeps the same open — the rebuild hazard is identical — and only
 * differs in whether the bank's `Mnemopi` carries the configured LLM.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import type { BankManager } from "@oh-my-pi/pi-mnemopi/core";
import { getAgentDir, getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { loadMnemopiConfig, type MnemopiBackendConfig } from "../mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	requireMnemopi,
	requireMnemopiCore,
	resolveBankReference,
} from "../mnemopi/state";
import { RAW_MEMORY_TYPE, RAW_SOURCE, type WikiLogEntry, WikiStore } from "../mnemopi/wiki";
import { type MaintainerPassResult, runWikiMaintainerPass } from "../mnemopi/wiki-maintainer";
import { runSkillProposerPass, type SkillPassResult } from "../mnemopi/wiki-skills";

export type MemoryWikiAction = "status" | "index" | "log" | "impact" | "run";

export interface MemoryWikiCommandFlags {
	/** Bank id or `owner/repo` slug; omitted = every bank with a db file under the store. */
	bank?: string;
	json?: boolean;
	/** `log`/`impact`: newest N entries (default 20 / 30, the store defaults). */
	limit?: number;
	/** `run`: also run the skill proposer after the maintainer. */
	skills?: boolean;
	/** `run`: print the prompt(s) instead of calling a model; nothing is written. */
	dryRun?: boolean;
}

export interface MemoryWikiCommandArgs {
	action: MemoryWikiAction;
	flags: MemoryWikiCommandFlags;
}

/** The slice of the mnemopi config needed to locate and open banks. */
export type WikiBankLocator = Pick<MnemopiBackendConfig, "dbPath" | "baseBank" | "globalBank" | "providerOptions">;

/**
 * Everything the command reads from the environment, so tests can point it at
 * a temp store without touching `~/.loom` or a model registry.
 */
export interface MemoryWikiRuntime {
	locator: WikiBankLocator;
	agentDir: string;
}

export interface WikiBankStatus {
	bank: string;
	rawRows: number;
	patterns: number;
	lastPassAt: string | null;
	/** Patterns grounded in ≥2 distinct sessions — the recurrence bar a skill proposal must clear. */
	recurringPatterns: number;
	skillsCited: string[];
	rejectedProposals: number;
}

export interface WikiRunResult {
	bank: string;
	dryRun: boolean;
	maintainer: MaintainerPassResult;
	skills?: SkillPassResult;
}

export async function runMemoryWikiCommand(cmd: MemoryWikiCommandArgs, runtime?: MemoryWikiRuntime): Promise<void> {
	const rt = runtime ?? (await defaultRuntime(cmd));
	await Promise.all([loadMnemopi(), loadMnemopiCore()]);
	const banks = selectBanks(rt.locator, cmd.flags.bank);
	if (banks.length === 0) {
		const wanted = cmd.flags.bank ? `bank "${cmd.flags.bank}"` : "any bank";
		process.stderr.write(`No memory database found for ${wanted} under ${dirname(rt.locator.dbPath)}\n`);
		process.exitCode = 1;
		return;
	}
	switch (cmd.action) {
		case "status":
			return withStores(rt.locator, banks, stores => printStatus(stores, cmd.flags));
		case "index":
			return withStores(rt.locator, banks, stores => printPerBank(stores, cmd.flags, store => store.renderIndex()));
		case "log":
			return withStores(rt.locator, banks, stores => printLog(stores, cmd.flags));
		case "impact":
			return withStores(rt.locator, banks, stores =>
				printPerBank(
					stores,
					cmd.flags,
					store => store.renderSkillImpact(cmd.flags.limit),
					store => store.listSkillImpact(cmd.flags.limit),
				),
			);
		case "run":
			return withStores(rt.locator, banks, stores => runPasses(stores, cmd.flags, rt.agentDir));
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Environment
// ───────────────────────────────────────────────────────────────────────────

async function defaultRuntime(cmd: MemoryWikiCommandArgs): Promise<MemoryWikiRuntime> {
	const agentDir = getAgentDir();
	const cwd = getProjectDir();
	const settings = await Settings.loadReadOnly({ agentDir, cwd });
	// Only a real `run` needs a model: the read-only verbs and `--dry-run`
	// never call `complete`, so they skip auth discovery — and the SDK/backend
	// module graph behind it — entirely. `status` on a store must not pay for
	// loading every provider.
	if (cmd.action !== "run" || cmd.flags.dryRun) {
		return { locator: loadMnemopiConfig(settings, agentDir), agentDir };
	}
	const [{ discoverAuthStorage }, { ModelRegistry }, { loadMnemopiConfigWithProviders }] = await Promise.all([
		import("../sdk"),
		import("../config/model-registry"),
		import("../mnemopi/backend"),
	]);
	const authStorage = await discoverAuthStorage(agentDir);
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		const locator = await loadMnemopiConfigWithProviders(settings, agentDir, modelRegistry, "memory-wiki-cli");
		return { locator, agentDir };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

/**
 * Same lookup as `MnemopiSessionState`'s bank discovery: `BankManager.listBanks`
 * over the store dir. Banks without a db file are skipped when enumerating, so
 * an inspection never materializes an empty `default` database as a side effect;
 * an explicit `--bank` that has no db yields an empty list and a clear error.
 */
function selectBanks(locator: WikiBankLocator, requested: string | undefined): string[] {
	const { BankManager } = requireMnemopiCore();
	const manager = new BankManager(dirname(locator.dbPath));
	const candidates = requested ? [resolveBankReference(requested)] : manager.listBanks();
	return candidates.filter(bank => existsSync(resolveBankDbPath(locator, manager, bank)));
}

function resolveBankDbPath(locator: WikiBankLocator, manager: BankManager, bank: string): string {
	const sharedBank = locator.globalBank ?? locator.baseBank ?? "default";
	return bank === sharedBank ? locator.dbPath : manager.getBankDbPath(bank);
}

/** Mirrors `openForeignBank` in `../mnemopi/state.ts` (not exported there). */
function openBank(locator: WikiBankLocator, bank: string): Mnemopi {
	const { BankManager } = requireMnemopiCore();
	const { Mnemopi } = requireMnemopi();
	return new Mnemopi({
		dbPath: resolveBankDbPath(locator, new BankManager(dirname(locator.dbPath)), bank),
		bank,
		sessionId: bank,
		authorId: "coding-agent",
		authorType: "agent",
		channelId: bank,
		...(locator.providerOptions as Record<string, unknown>),
		reconcile: false,
	} as ConstructorParameters<typeof Mnemopi>[0]);
}

async function withStores(
	locator: WikiBankLocator,
	banks: readonly string[],
	fn: (stores: WikiStore[]) => Promise<void> | void,
): Promise<void> {
	const stores = banks.map(bank => new WikiStore(bank, openBank(locator, bank)));
	try {
		await fn(stores);
	} finally {
		// Pattern rows embed in the background; a session keeps living to let
		// that finish, a CLI process does not — drain before closing or the
		// rows land with embed_text NULL and never surface to vector recall.
		await Promise.allSettled(stores.map(store => store.memory.flushExtractions()));
		for (const store of stores) store.memory.close();
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Read-only verbs
// ───────────────────────────────────────────────────────────────────────────

export function bankStatus(store: WikiStore): WikiBankStatus {
	const patterns = store.listPatterns();
	const raw = store.memory.db
		.query(`SELECT count(*) AS n FROM working_memory WHERE source = ? AND memory_type = ?`)
		.get(RAW_SOURCE, RAW_MEMORY_TYPE) as { n: number } | null;
	const skills = new Set<string>();
	for (const pattern of patterns) for (const skill of pattern.skills) skills.add(skill);
	return {
		bank: store.bank,
		rawRows: raw?.n ?? 0,
		patterns: patterns.length,
		lastPassAt: store.lastPassAt(),
		recurringPatterns: patterns.filter(p => p.sessions.length >= 2).length,
		skillsCited: [...skills].sort(),
		rejectedProposals: store.rejectedProposals().length,
	};
}

function printStatus(stores: WikiStore[], flags: MemoryWikiCommandFlags): void {
	const statuses = stores.map(bankStatus);
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
		return;
	}
	const lines: string[] = [];
	for (const s of statuses) {
		lines.push(
			`${s.bank}: ${s.rawRows} raw rows, ${s.patterns} patterns (${s.recurringPatterns} recurring), ` +
				`${s.rejectedProposals} rejected proposals, last pass ${s.lastPassAt ?? "never"}` +
				(s.skillsCited.length > 0 ? `, skills: ${s.skillsCited.join(", ")}` : ""),
		);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function printPerBank(
	stores: WikiStore[],
	flags: MemoryWikiCommandFlags,
	renderText: (store: WikiStore) => string,
	renderJson: (store: WikiStore) => unknown = store => store.listPatterns(),
): void {
	if (flags.json) {
		const out: Record<string, unknown> = {};
		for (const store of stores) out[store.bank] = renderJson(store);
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return;
	}
	const sections = stores.map(store =>
		stores.length > 1 ? `## ${store.bank}\n${renderText(store)}` : renderText(store),
	);
	process.stdout.write(`${sections.join("\n\n")}\n`);
}

function printLog(stores: WikiStore[], flags: MemoryWikiCommandFlags): void {
	printPerBank(
		stores,
		flags,
		store => {
			const entries = store.listLog(flags.limit);
			if (entries.length === 0) return "(no passes yet)";
			return entries.map(formatLogEntry).join("\n\n");
		},
		store => store.listLog(flags.limit),
	);
}

function formatLogEntry(entry: WikiLogEntry): string {
	// `summary` already carries the pass header line + decisions the store
	// wrote; only the sampled ids need appending for an operator.
	const sampled = entry.sampled.length > 0 ? `\nsampled: ${entry.sampled.join(", ")}` : "";
	return `${entry.summary}${sampled}`;
}

// ───────────────────────────────────────────────────────────────────────────
// run
// ───────────────────────────────────────────────────────────────────────────

async function runPasses(stores: WikiStore[], flags: MemoryWikiCommandFlags, agentDir: string): Promise<void> {
	const dryRun = flags.dryRun === true;
	const results: WikiRunResult[] = [];
	for (const store of stores) {
		// Dry run: surface the exact prompt a real pass would send, then answer
		// with null. The maintainer's `dryRun` keeps it from logging the resulting
		// malformed-output pass (which would otherwise advance `lastPassAt` and
		// hide these rows from the next real pass); the proposer writes nothing
		// on a null completion by contract.
		const complete = dryRun
			? async (prompt: string): Promise<null> => {
					process.stdout.write(`--- prompt (${store.bank}) ---\n${prompt}\n--- end prompt ---\n`);
					return null;
				}
			: undefined;
		const result: WikiRunResult = {
			bank: store.bank,
			dryRun,
			maintainer: await runWikiMaintainerPass(store, { complete, dryRun }),
		};
		if (flags.skills) result.skills = await runSkillProposerPass(store, { complete, agentDir });
		results.push(result);
	}
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
		return;
	}
	for (const result of results) {
		process.stdout.write(
			`${result.bank}${result.dryRun ? " (dry-run)" : ""}: ${JSON.stringify(result.maintainer)}\n`,
		);
		if (result.skills) process.stdout.write(`  skills: ${JSON.stringify(result.skills)}\n`);
	}
}
