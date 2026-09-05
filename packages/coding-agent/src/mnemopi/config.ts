import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MnemopiOptions } from "@oh-my-pi/pi-mnemopi";
import { getMemoriesDir, logger, MANAGED_RUN_OWNER_FILE } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import * as git from "../utils/git";

export type MnemopiLlmMode = "none" | "smol" | "remote";

export type MnemopiScoping = "global" | "per-project" | "per-project-tagged";

export type MnemopiProviderOptions = Pick<
	MnemopiOptions,
	"noEmbeddings" | "embeddingModel" | "embeddingApiUrl" | "embeddingApiKey" | "llm" | "debug"
>;

export interface MnemopiBackendConfig {
	dbPath: string;
	baseBank?: string;
	bank: string;
	globalBank?: string;
	retainBank?: string;
	recallBanks?: readonly string[];
	/** `owner/repo` slug actually driving `bank`/`retainBank` right now — pin, cwd git-origin, or touched-repo derived. `undefined` means the cwd-hash fallback is in play. */
	bankRepo?: string;
	/**
	 * True once `bankRepo` is pinned (setting/env) or derived from `cwd`'s own
	 * git origin — both are stable for the lifetime of the session (cwd never
	 * changes except via `/move`), so there is nothing to re-detect. False
	 * means `bankRepo` is eligible for touched-repo re-derivation
	 * (`MnemopiSessionState.maybeRebindTouchedRepoBank`) — the console-lane
	 * case where the session boots outside any repo.
	 */
	bankRepoLocked?: boolean;
	/**
	 * True only for an EXPLICIT operator pin (`mnemopi.bankRepo` setting or
	 * `LOOM_MNEMOPI_BANK_REPO` env — precedence steps (a)/(b)). Unlike
	 * `bankRepoLocked`, this is false when `bankRepo` was merely derived from
	 * `cwd`'s git origin (step (d)) — that derivation is stable for the
	 * session too, but an agent-declared `repo` (step (c), see
	 * `MnemopiSessionState.declareBankRepo`) still outranks it and must be
	 * able to override it. Only an operator pin is untouchable.
	 */
	bankRepoPinned?: boolean;
	/** Raw `mnemopi.bank` setting value, preserved so a later bank-scope recompute (touched-repo rebind) uses the same prefix. */
	configuredBank?: string;
	scoping?: MnemopiScoping;
	autoRecall: boolean;
	autoRetain: boolean;
	polyphonicRecall: boolean;
	enhancedRecall: boolean;
	proactiveLinking: boolean;
	retainEveryNTurns: number;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	treeEnabled: boolean;
	treeRoot: string;
	treeLeafCharCap: number;
	/** Per-subtree entry-point row cap (default 200). */
	treeEntryRows: number;
	/** Purge archived rows older than this many days (0 disables GC; default 90). */
	treeArchiveGcDays: number;
	/** Collapse duplicate fact writes into the existing row (default true). */
	treeDedupe: boolean;
	/** Run the background Wiki Maintainer / Skill Proposer after retention (default true). */
	wiki: boolean;
	debug: boolean;
	providerOptions: MnemopiProviderOptions;
	llmMode: MnemopiLlmMode;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
}

export function loadMnemopiConfig(settings: Settings, agentDir: string): MnemopiBackendConfig {
	const configuredDbPath = settings.get("mnemopi.dbPath");
	const cwd = settings.getCwd();
	const scoping = settings.get("mnemopi.scoping");
	// Repo-keyed bank: an explicit pin (setting or LOOM_MNEMOPI_BANK_REPO env,
	// console-injected at boot) always wins; otherwise resolveBankRepo derives
	// the slug lazily from whatever repo `cwd` sits in RIGHT NOW, so the bank
	// tracks the session's actual working repo instead of freezing at exec.
	const pinnedBankRepo = settings.get("mnemopi.bankRepo")?.trim() || Bun.env.LOOM_MNEMOPI_BANK_REPO?.trim();
	const bankRepo = resolveBankRepo(cwd, settings);
	const dbPath = configuredDbPath ?? path.join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db");
	const configuredBank = settings.get("mnemopi.bank");
	const scope = computeMnemopiBankScope(configuredBank, cwd, scoping, bankRepo);
	let recallBanks =
		scoping === "global" ? scope.recallBanks : extendRecallWithLegacyBanks(scope.recallBanks, dbPath, cwd);
	// Git-derived (not explicitly pinned) repo banks are new: 162 of 164 rows
	// on the reference install live in cwd-derived banks (72 of them in one
	// shared `workspace-<hash>` drawer), because the frozen env-var key almost
	// never matched a real repo slug. Recall must keep reading the cwd bank a
	// bare `bankRepo`-less session at this same cwd would have used, or a
	// session that starts resolving a slug today loses everything it wrote
	// yesterday. Pinned deployments are unaffected — they never had a cwd
	// bank to begin with, since the pin has always taken cwd out of the id.
	if (scoping !== "global" && bankRepo && !pinnedBankRepo) {
		const cwdOnlyBank = computeMnemopiBankScope(configuredBank, cwd, scoping, undefined).bank;
		if (!recallBanks.includes(cwdOnlyBank)) recallBanks = [...recallBanks, cwdOnlyBank];
	}
	const llmMode = settings.get("mnemopi.llmMode");
	const embeddingOverride = settings.get("mnemopi.embeddingModel");
	const embeddingVariant = settings.get("mnemopi.embeddingVariant");
	// Map the variant explicitly rather than indexing an object with the raw config
	// value (which could resolve an inherited property like `__proto__`); any value
	// other than the multilingual variant falls back to the English default.
	const variantModel =
		embeddingVariant === "multilingual" ? "intfloat/multilingual-e5-large" : "BAAI/bge-base-en-v1.5";
	// Precedence: explicit `mnemopi.embeddingModel` setting > `MNEMOPI_EMBEDDING_MODEL`
	// env (documented model-level override) > variant-derived default. Without the env
	// term a variant default would silently shadow a user's configured env model.
	const embeddingModel = embeddingOverride?.trim() || Bun.env.MNEMOPI_EMBEDDING_MODEL?.trim() || variantModel;
	return {
		dbPath,
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks,
		bankRepo,
		// Locked once cwd-git-origin-derived or pinned — both are stable for the
		// whole session, so `MnemopiSessionState.maybeRebindTouchedRepoBank`
		// (precedence step d) skips touched-repo re-derivation for a bank that
		// will never move on its own. `bankRepoPinned` is the narrower flag: an
		// agent-declared `repo` (step c) is still allowed to override a
		// cwd-origin derivation, just never an explicit operator pin.
		bankRepoLocked: bankRepo !== undefined,
		bankRepoPinned: Boolean(pinnedBankRepo),
		configuredBank,
		scoping,
		autoRecall: settings.get("mnemopi.autoRecall"),
		autoRetain: settings.get("mnemopi.autoRetain"),
		polyphonicRecall: settings.get("mnemopi.polyphonicRecall"),
		enhancedRecall: settings.get("mnemopi.enhancedRecall"),
		proactiveLinking: settings.get("mnemopi.proactiveLinking"),
		retainEveryNTurns: Math.max(1, Math.floor(settings.get("mnemopi.retainEveryNTurns"))),
		recallLimit: Math.max(1, Math.floor(settings.get("mnemopi.recallLimit"))),
		recallContextTurns: Math.max(1, Math.floor(settings.get("mnemopi.recallContextTurns"))),
		recallMaxQueryChars: Math.max(256, Math.floor(settings.get("mnemopi.recallMaxQueryChars"))),
		injectionTokenLimit: Math.max(256, Math.floor(settings.get("mnemopi.injectionTokenLimit"))),
		treeEnabled: settings.get("mnemopi.treeEnabled"),
		treeRoot:
			settings.get("memory.tree.root") ??
			settings.get("mnemopi.treeRoot") ??
			path.join(getMemoriesDir(agentDir), "tree"),
		treeLeafCharCap: Math.max(512, Math.floor(settings.get("mnemopi.treeLeafCharCap"))),
		treeEntryRows: Math.max(20, Math.floor(settings.get("mnemopi.treeEntryRows"))),
		treeArchiveGcDays: Math.max(0, Math.floor(settings.get("mnemopi.treeArchiveGcDays"))),
		treeDedupe: settings.get("mnemopi.treeDedupe"),
		wiki: settings.get("mnemopi.wiki"),
		debug: settings.get("mnemopi.debug"),
		providerOptions: {
			noEmbeddings: settings.get("mnemopi.noEmbeddings"),
			debug: settings.get("mnemopi.debug"),
			embeddingModel,
			embeddingApiUrl: settings.get("mnemopi.embeddingApiUrl"),
			embeddingApiKey: settings.get("mnemopi.embeddingApiKey"),
			llm:
				llmMode === "remote"
					? {
							baseUrl: settings.get("mnemopi.llmBaseUrl"),
							apiKey: settings.get("mnemopi.llmApiKey"),
							model: settings.get("mnemopi.llmModel"),
						}
					: false,
		},
		llmMode,
		llmBaseUrl: settings.get("mnemopi.llmBaseUrl"),
		llmApiKey: settings.get("mnemopi.llmApiKey"),
		llmModel: settings.get("mnemopi.llmModel"),
	};
}

const DEFAULT_SHARED_BANK = "default";

// Cap legacy-bank scanning at session start so a pathological banks/
// directory cannot dominate startup latency.
const LEGACY_BANK_SCAN_LIMIT = 64;

export interface MnemopiBankScope {
	baseBank: string;
	bank: string;
	globalBank: string;
	retainBank: string;
	recallBanks: readonly string[];
}

/**
 * Resolve write/recall banks for a session.
 *
 * Mnemopi has no tag-filtered recall, so `per-project-tagged` maps to a
 * project-local write bank plus a shared recall-visible bank. The project
 * bank is derived purely from {@link cwd} — see {@link projectBank} for the
 * stability contract.
 */
export function computeMnemopiBankScope(
	configured: string | undefined,
	cwd: string,
	scoping: MnemopiScoping,
	bankRepo?: string,
): MnemopiBankScope {
	const project = projectBank(configured, cwd, bankRepo);
	const globalBank = sharedBank(configured);
	switch (scoping) {
		case "global":
			return {
				baseBank: globalBank,
				bank: globalBank,
				globalBank,
				retainBank: globalBank,
				recallBanks: [globalBank],
			};
		case "per-project":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: [project],
			};
		case "per-project-tagged":
			return {
				baseBank: globalBank,
				bank: project,
				globalBank,
				retainBank: project,
				recallBanks: project === globalBank ? [project] : [project, globalBank],
			};
	}
}

function sharedBank(configured: string | undefined): string {
	return sanitizeBankName(configured) ?? DEFAULT_SHARED_BANK;
}

/**
 * Derive the per-project bank id.
 *
 * Two modes. With `bankRepo` set — a GitHub `owner/repo` slug, either an
 * explicit pin (`mnemopi.bankRepo` setting / `LOOM_MNEMOPI_BANK_REPO` env)
 * or lazily derived from the enclosing repo's `origin` remote by
 * {@link resolveBankRepo} — the bank id is the slug itself, no `cwd`
 * component. The slug is globally unique, so one repository converges on
 * ONE bank regardless of checkout path or Linux account: kevin's session in
 * `/home/kevin/workspace/BehaviorOS` and ubuntu's in
 * `/home/ubuntu/workspace/BehaviorOS` read and write the same rows.
 *
 * Without it, the bank id derives from `cwd` alone. Earlier versions
 * resolved the enclosing git root before hashing, which made the bank id
 * unstable: removing or adding a `.git` anywhere above the cwd repointed the
 * same conversation directory to a different bank and fragmented memories
 * (#2412). This function itself does no git lookup — that instability
 * doesn't recur, because `bankRepo` is resolved once, up front, by the
 * caller; the rescue path for already-fragmented installs lives in
 * {@link extendRecallWithLegacyBanks}.
 */
function projectBank(configured: string | undefined, cwd: string, bankRepo: string | undefined): string {
	const slug = bankRepo?.trim() ? sanitizeBankName(bankRepo) : undefined;
	if (slug) {
		// Repo-keyed mode: the GitHub slug alone IS the project identity —
		// globally unique, so no path/hash suffix. One bank per repository,
		// shared across accounts and checkout locations.
		const base = sanitizeBankName(configured);
		return base && base !== slug ? `${base}-${slug}` : slug;
	}
	const projectRoot = path.resolve(cwd || ".");
	const project = projectBankSegment(projectRoot);
	const base = sanitizeBankName(configured);
	return limitBankName(base ? `${base}-${project}` : project);
}
function projectBankSegment(projectRoot: string): string {
	const project = sanitizeBankName(path.basename(projectRoot)) ?? "default";
	return limitBankName(`${project}-${Bun.hash(projectRoot).toString(36)}`);
}

// Git-derivation results, keyed by resolved directory. A session's cwd is
// stable turn-to-turn, so this avoids re-reading `.git/config` on every
// recall/retain call — the whole point of resolving lazily is to react to
// directory changes, not to re-shell git on every tool invocation.
const bankRepoDerivationCache = new Map<string, string | undefined>();

/**
 * Resolve the `owner/repo` slug used to key the per-project bank, evaluated
 * lazily — i.e. against whichever directory the caller is ACTUALLY working
 * in right now, not once at process boot.
 *
 * Precedence:
 *  1. Explicit pin: `mnemopi.bankRepo` setting, then `LOOM_MNEMOPI_BANK_REPO`
 *     env (console-injected at boot). Always wins, so existing pinned
 *     deployments are byte-identical to before.
 *  2. Otherwise, derive the slug from the git repository enclosing `dir`:
 *     resolve the repo root, read its `origin` remote URL, and parse
 *     `owner/repo` out of it. Previously the ONLY source was the frozen
 *     boot-time env var, which the console injects for lanes booted at
 *     `~/workspace` (no origin there) — so ~99% of writes landed in
 *     cwd-hash banks instead of the intended repo-keyed one.
 *  3. No enclosing repo, or no parseable `origin`: return `undefined` so
 *     {@link projectBank} falls back to its cwd-hash derivation, unchanged.
 */
export function resolveBankRepo(dir: string, settings?: Pick<Settings, "get">): string | undefined {
	const pinned = settings?.get("mnemopi.bankRepo")?.trim() || Bun.env.LOOM_MNEMOPI_BANK_REPO?.trim();
	if (pinned) return pinned;
	const resolved = path.resolve(dir || ".");
	const cached = bankRepoDerivationCache.get(resolved);
	if (cached !== undefined || bankRepoDerivationCache.has(resolved)) return cached;
	const derived = deriveBankRepoFromGitOrigin(resolved) ?? deriveBankRepoFromManagedRunOwner(resolved);
	bankRepoDerivationCache.set(resolved, derived);
	return derived;
}

/**
 * Precedence step (c) — validate an agent-declared `repo` param on the
 * `memory` tool (`MemoryTool`/`MnemopiSessionState.declareBankRepo`). Unlike
 * {@link parseOwnerRepoSlug}, which extracts `owner/repo` out of a git remote
 * URL, this validates a slug the agent typed directly: exactly two segments
 * drawn from the characters GitHub actually allows in an owner or repo name
 * (alphanumerics, `.`, `_`, `-`), with a trailing `.git` stripped the same way
 * the remote-URL path strips it.
 *
 * The charset is checked explicitly rather than by asserting
 * `sanitizeBankName(seg) === seg`: that equality test rejected every real
 * repository with a dot in its name (`vercel/next.js`, `owner/docs.io`) even
 * though the git-origin path at {@link parseOwnerRepoSlug} accepts exactly
 * those slugs — so the same repository was declarable by inference but not by
 * hand. Bank-name legality is not this function's job; {@link projectBank}
 * still routes the accepted slug through `sanitizeBankName`.
 *
 * Rejects `"not-a-slug"` (no `/`), `"a/b/c/d"` (too many segments), `""`,
 * `"owner//repo"`, and `.`/`..` segments, so a slip of the agent's fingers
 * fails loudly instead of silently keying a nonsense bank.
 */
const DECLARED_SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseDeclaredBankRepo(value: string): string | undefined {
	const segments = value
		.trim()
		.replace(/\.git$/, "")
		.split("/");
	if (segments.length !== 2) return undefined;
	const [owner, repo] = segments;
	for (const segment of [owner, repo]) {
		if (!segment || segment === "." || segment === "..") return undefined;
		if (!DECLARED_SLUG_SEGMENT.test(segment)) return undefined;
	}
	return `${owner}/${repo}`;
}

/**
 * Precedence step (d) — used when a session has no pin AND `cwd` itself has
 * no git origin (the console-lane case: booted at a container dir like
 * `~/workspace` with no `.git` of its own). `dirs` are candidate checkout
 * directories the session actually touched via tool calls, ordered
 * MOST-RECENTLY-TOUCHED-FIRST by the caller (`MnemopiSessionState` reverses
 * the transcript before scanning) — the first dir that resolves to a real
 * `owner/repo` slug wins the WRITE bank. Reuses {@link resolveBankRepo}'s
 * cached git-origin parser per directory (no `gh` CLI shellout: this can run
 * on the per-turn rebind path, so it has to stay as cheap as the cwd path
 * it's extending).
 */
export function resolveBankRepoFromTouchedDirs(dirs: readonly string[]): string | undefined {
	for (const dir of dirs) {
		const slug = resolveBankRepo(dir);
		if (slug) return slug;
	}
	return undefined;
}

/**
 * Every distinct `owner/repo` slug resolvable from `dirs` (order of `dirs`
 * irrelevant here — used to widen RECALL, not to pick the write bank, so
 * first-seen-in-input order is fine and dedupe is all that matters).
 */
export function collectBankReposFromTouchedDirs(dirs: readonly string[]): string[] {
	const slugs: string[] = [];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const slug = resolveBankRepo(dir);
		if (slug && !seen.has(slug)) {
			seen.add(slug);
			slugs.push(slug);
		}
	}
	return slugs;
}

/**
 * Recompute a config's bank routing (`bank`/`retainBank`/`recallBanks`/…)
 * for a newly-resolved `bankRepo`, used by `MnemopiSessionState`'s
 * touched-repo rebind. Recall only ever GROWS: every bank the config was
 * already reading from (including the cwd-hash fallback a pin-less,
 * touched-repo-less session would have used) stays in the union, plus a
 * bank for every OTHER touched repo — a session bouncing between two
 * checkouts keeps recalling from both while writing to whichever it
 * touched most recently.
 */
export function withTouchedRepoBankScope(
	config: MnemopiBackendConfig,
	cwd: string,
	bankRepo: string | undefined,
	touchedRepos: readonly string[],
): MnemopiBackendConfig {
	const scoping = config.scoping ?? "per-project";
	const scope = computeMnemopiBankScope(config.configuredBank, cwd, scoping, bankRepo);
	if (scoping === "global") {
		return {
			...config,
			baseBank: scope.baseBank,
			bank: scope.bank,
			globalBank: scope.globalBank,
			retainBank: scope.retainBank,
			recallBanks: scope.recallBanks,
			bankRepo,
		};
	}
	const recallBanks = [...scope.recallBanks];
	const seen = new Set(recallBanks);
	for (const prior of config.recallBanks ?? []) {
		if (!seen.has(prior)) {
			recallBanks.push(prior);
			seen.add(prior);
		}
	}
	for (const repo of touchedRepos) {
		const repoBank = computeMnemopiBankScope(config.configuredBank, cwd, scoping, repo).bank;
		if (!seen.has(repoBank)) {
			recallBanks.push(repoBank);
			seen.add(repoBank);
		}
	}
	return {
		...config,
		baseBank: scope.baseBank,
		bank: scope.bank,
		globalBank: scope.globalBank,
		retainBank: scope.retainBank,
		recallBanks,
		bankRepo,
	};
}

/**
 * Read the `origin` remote URL out of the repo enclosing `dir` and parse an
 * `owner/repo` slug from it. Resolves the repo purely via on-disk `.git`
 * walking (`git.repo.resolveSync`, no subprocess) so it stays cheap enough
 * to call from hot memory paths. Any failure — no repo, unreadable config,
 * no `origin`, unparseable URL — yields `undefined`, never throws.
 */
function deriveBankRepoFromGitOrigin(dir: string): string | undefined {
	let repository: git.GitRepository | null;
	try {
		repository = git.repo.resolveSync(dir);
	} catch (error) {
		logger.debug("Mnemopi: git repo resolution failed", { dir, error: String(error) });
		return undefined;
	}
	if (!repository) return undefined;
	let configText: string;
	try {
		configText = fs.readFileSync(path.join(repository.commonDir, "config"), "utf8");
	} catch {
		return undefined;
	}
	const originUrl = parseGitConfigOriginUrl(configText);
	return originUrl ? parseOwnerRepoSlug(originUrl) : undefined;
}

/**
 * Inherit the bank repo of the checkout a MANAGED RUN DIR was cut from.
 *
 * Task isolation and run scratch both hand a session a working directory that
 * is not a checkout: an isolated task gets a disposable dir (isolation never
 * guesses which sibling checkout you meant), and `$OMP_RUN_SCRATCH` is a bare
 * dir under the scratch root. Neither has a `.git`, so
 * {@link deriveBankRepoFromGitOrigin} finds nothing and the bank fell back to
 * the cwd hash — which is why subagent memory landed in per-run drawers named
 * after the isolation segment (`t<digest>-<hash>`) instead of the repo bank
 * its parent session was writing to. The transcripts stranded there are
 * ordinary repo work, so recall for that repo could never see them.
 *
 * Both dir kinds drop a `MANAGED_RUN_OWNER_FILE` marker recording `repoRoot`:
 * the git root the run was cut from, or the resolved cwd when the spawn
 * happened outside any checkout. Reading `origin` out of THAT root is what
 * makes a scratch/isolation dir inherit its parent checkout's git config.
 *
 * Walks up from `dir` because the session's cwd may be a subdirectory of the
 * managed dir (a clone made inside it), stopping at the marker, the
 * filesystem root, or {@link OWNER_MARKER_SEARCH_DEPTH} levels. One hop only:
 * `repoRoot` is resolved as a git checkout, never re-inherited, so a marker
 * chain cannot recurse.
 */
const OWNER_MARKER_SEARCH_DEPTH = 4;

function deriveBankRepoFromManagedRunOwner(dir: string): string | undefined {
	let current = dir;
	for (let depth = 0; depth <= OWNER_MARKER_SEARCH_DEPTH; depth++) {
		let raw: string;
		try {
			raw = fs.readFileSync(path.join(current, MANAGED_RUN_OWNER_FILE), "utf8");
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
			continue;
		}
		let marker: unknown;
		try {
			marker = JSON.parse(raw);
		} catch {
			return undefined;
		}
		if (!marker || typeof marker !== "object" || !("repoRoot" in marker)) return undefined;
		const repoRoot = marker.repoRoot;
		if (typeof repoRoot !== "string" || !repoRoot.trim()) return undefined;
		const resolved = path.resolve(repoRoot);
		// `repoRoot` equal to the marker dir means the run was spawned outside
		// any checkout: there is no parent git config to inherit, and probing
		// it again would just repeat the lookup that already failed.
		if (resolved === path.resolve(current)) return undefined;
		return deriveBankRepoFromGitOrigin(resolved);
	}
	return undefined;
}

/** Extract the `url` value of the `[remote "origin"]` section from raw git config text. */
function parseGitConfigOriginUrl(configText: string): string | undefined {
	let inOrigin = false;
	for (const rawLine of configText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		const section = line.match(/^\[remote\s+"([^"]+)"\]$/);
		if (section) {
			inOrigin = section[1] === "origin";
			continue;
		}
		if (line.startsWith("[")) {
			inOrigin = false;
			continue;
		}
		if (!inOrigin) continue;
		const urlMatch = line.match(/^url\s*=\s*(.+)$/);
		if (urlMatch) return urlMatch[1].trim();
	}
	return undefined;
}

/**
 * Parse `owner/repo` out of a git remote URL, handling both the SSH scp-like
 * form (`git@host:owner/repo.git`, `ssh://git@host/owner/repo.git`) and the
 * HTTPS form (`https://host/owner/repo(.git)?`). Returns `undefined` for
 * anything that doesn't resolve to at least two path segments.
 */
function parseOwnerRepoSlug(url: string): string | undefined {
	const scpMatch = url.trim().match(/^[^@/\s]+@[^:/\s]+:(.+)$/);
	let pathname: string | undefined;
	if (scpMatch) {
		pathname = scpMatch[1];
	} else {
		try {
			pathname = new URL(url.trim()).pathname;
		} catch {
			return undefined;
		}
	}
	const segments = pathname
		.replace(/\.git$/, "")
		.split("/")
		.filter(Boolean);
	if (segments.length < 2) return undefined;
	return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

/**
 * Discover sibling banks under `<dbDir>/banks/` whose `working_memory` rows
 * all carry the active `cwd` in `metadata_json.$.cwd`, and add those safe
 * single-cwd banks to the recall set. This rescues memories stranded by a
 * previous, less-stable bank derivation (#2412) without recalling mixed-cwd
 * legacy banks wholesale under per-project isolation.
 *
 * Robust by design: a missing banks directory, unreadable bank dir, or
 * corrupt SQLite file is silently skipped. Scanning is capped at
 * {@link LEGACY_BANK_SCAN_LIMIT} to bound startup cost.
 */
export function extendRecallWithLegacyBanks(
	resolved: readonly string[],
	dbPath: string,
	cwd: string,
): readonly string[] {
	const banksDir = path.join(path.dirname(dbPath), "banks");
	const cwdAbs = path.resolve(cwd || ".");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(banksDir, { withFileTypes: true });
	} catch {
		return resolved;
	}
	const have = new Set(resolved);
	const extras: string[] = [];
	let scanned = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || have.has(entry.name)) continue;
		if (scanned >= LEGACY_BANK_SCAN_LIMIT) break;
		scanned++;
		const candidate = path.join(banksDir, entry.name, "mnemopi.db");
		if (bankOnlyHasCwd(candidate, cwdAbs)) extras.push(entry.name);
	}
	return extras.length === 0 ? resolved : [...resolved, ...extras];
}

function bankOnlyHasCwd(dbPath: string, cwd: string): boolean {
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		const row = db
			.prepare<{ matching: number; unsafe: number }, [string, string]>(`
				SELECT
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') = ? THEN 1 ELSE 0 END) AS matching,
					SUM(CASE WHEN json_extract(metadata_json, '$.cwd') IS NULL OR json_extract(metadata_json, '$.cwd') <> ? THEN 1 ELSE 0 END) AS unsafe
				FROM working_memory
			`)
			.get(cwd, cwd);
		return (row?.matching ?? 0) > 0 && (row?.unsafe ?? 0) === 0;
	} catch (error) {
		logger.debug("Mnemopi: legacy bank probe failed", { dbPath, error: String(error) });
		return false;
	} finally {
		try {
			db?.close();
		} catch {
			// nothing to do — read-only handle.
		}
	}
}
export function sanitizeBankName(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized ? limitBankName(sanitized) : undefined;
}

function limitBankName(name: string): string {
	if (name.length <= 64) return name;
	const hash = Bun.hash(name).toString(36);
	const prefixLength = Math.max(1, 63 - hash.length);
	const prefix = name.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

export function truncateApproxTokens(text: string, tokenLimit: number): string {
	const maxChars = Math.max(0, tokenLimit * 4);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
