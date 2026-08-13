import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * What auto-compaction owes the session when the summarizer models say no.
 *
 * A usage window that is spent (the provider's 5h cap, a quota ceiling) is a
 * "not now", not a "never": compaction must walk the rest of the enabled pool
 * and, when that is spent too, archive the history locally with snapcompact so
 * the turn can proceed. The one failure that stays loud is a credentials
 * failure — the operator has to fix that, and it blocks every ordinary turn
 * anyway (issue #986).
 *
 * The waiting rule matters just as much as the falling-back rule: a provider
 * that answers "retry after 4h37m" must never be obeyed literally. Sleeping on
 * that is what makes a session sit in "compacting" seemingly forever.
 */
describe("compaction quota exhaustion fallback", () => {
	const tempDirs: TempDir[] = [];
	const stores: AuthStorage[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores.splice(0)) store.close();
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	/** A spent 5h window, shaped like the providers report it. */
	function usageLimitError(options: { retryAfterMs?: number } = {}): Error {
		const retryAfter = options.retryAfterMs === undefined ? "" : ` retry-after-ms: ${options.retryAfterMs}`;
		return Object.assign(
			new Error(`429 {"error":{"message":"You have hit your 5h usage limit for this model.${retryAfter}"}}`),
			{ status: 429 },
		);
	}

	function contextOverflowError(): Error {
		return Object.assign(
			new Error(
				'400 {"error":{"message":"prompt is too long: 402000 tokens > 200000 maximum context length","type":"invalid_request_error"}}',
			),
			{ status: 400 },
		);
	}

	function authError(): Error {
		return Object.assign(
			new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
			{ status: 401 },
		);
	}

	function bundledActiveModel(): Model {
		// Vision-capable: snapcompact renders history to frames, so the local
		// archive is only reachable behind an image-capable active model.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled anthropic model");
		return model;
	}

	interface RunResult {
		/** Models handed to `compact()`, in the order the chain tried them. */
		tried: Model[];
		notices: string[];
		endAction: string | undefined;
		endErrorMessage: string | undefined;
		thrown: unknown;
		compactionSummary: string | undefined;
	}

	async function runAutoCompaction(options: {
		compact: (model: Model) => never;
		retryEnabled?: boolean;
	}): Promise<RunResult> {
		const dir = TempDir.createSync("@pi-compaction-quota-");
		tempDirs.push(dir);
		const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		stores.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "sk-ant-api-test-key");
		authStorage.setRuntimeApiKey("openai", "test-openai-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const sessionManager = SessionManager.inMemory(dir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept" }],
			timestamp: Date.now(),
		});

		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue({
			firstKeptEntryId,
			messagesToSummarize: [
				{ role: "user", content: [{ type: "text", text: "an older turn worth archiving" }], timestamp: 1 },
			],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy: "context-full" },
		});

		const tried: Model[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, candidate) => {
			tried.push(candidate);
			throw options.compact(candidate);
		});

		const agent = new Agent({
			initialState: { model: bundledActiveModel(), systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
				// Retry backoff is a separate axis: only the long-wait test needs it.
				"retry.enabled": options.retryEnabled ?? false,
			}),
			modelRegistry,
		});

		const notices: string[] = [];
		let endAction: string | undefined;
		let endErrorMessage: string | undefined;
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") notices.push(event.message);
			if (event.type === "auto_compaction_end") {
				endAction = event.action;
				endErrorMessage = event.errorMessage;
			}
		});

		try {
			const thrown = await session.runIdleCompaction().then(
				() => undefined,
				error => error,
			);
			const compactionEntry = sessionManager.getBranch().find(entry => entry.type === "compaction");
			return {
				tried,
				notices,
				endAction,
				endErrorMessage,
				thrown,
				compactionSummary:
					compactionEntry && "summary" in compactionEntry ? (compactionEntry.summary as string) : undefined,
			};
		} finally {
			await session.dispose();
		}
	}

	it("walks the whole enabled pool, widest window first, when every model is quota-exhausted", async () => {
		const result = await runAutoCompaction({
			compact: () => {
				throw usageLimitError();
			},
		});

		// The configured summarizer goes first — preference beats width, or the
		// setting would mean nothing.
		const active = bundledActiveModel();
		expect(`${result.tried[0]?.provider}/${result.tried[0]?.id}`).toBe(`${active.provider}/${active.id}`);
		// A single spare beyond the configured/role models is not a chain: the
		// point of the fallback is that an exhausted account cannot dead-end
		// compaction while other enabled models are still willing to summarize.
		expect(result.tried.length).toBeGreaterThan(2);
		// The appended pool is ordered widest-window first, so the model most
		// likely to hold the input is asked before the ones that would overflow.
		const poolWindows = result.tried.slice(1).map(model => model.contextWindow ?? 0);
		expect(poolWindows).toEqual([...poolWindows].sort((a, b) => b - a));
		// Every candidate is distinct: retrying the same model is not fallback.
		const ids = result.tried.map(model => `${model.provider}/${model.id}`);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("archives locally with snapcompact once every summarizer is quota-exhausted", async () => {
		const result = await runAutoCompaction({
			compact: () => {
				throw usageLimitError();
			},
		});

		expect(result.endAction).toBe("snapcompact");
		expect(result.endErrorMessage).toBeUndefined();
		expect(result.thrown).toBeUndefined();
		expect(result.compactionSummary).toBeDefined();
		const notice = result.notices.find(message => message.startsWith("no compaction model could summarize"));
		expect(notice).toBeDefined();
		expect(notice).toContain("archived this history with snapcompact instead.");
		// The user is told which wall they hit, not just that something failed.
		expect(notice).toContain("5h usage limit");
	});

	it("refuses to sleep out a 5h window on the last candidate", async () => {
		// The regression: `retry-after-ms` pointing at the window reset used to be
		// obeyed verbatim once no candidate remained, parking the session inside
		// auto-compaction for hours. Under the bug this test does not fail an
		// assertion — it never finishes, and the suite timeout is the signal.
		const fourHoursThirtySevenMinutes = 16_620_000;
		const started = Date.now();
		const result = await runAutoCompaction({
			retryEnabled: true,
			compact: () => {
				throw usageLimitError({ retryAfterMs: fourHoursThirtySevenMinutes });
			},
		});

		expect(Date.now() - started).toBeLessThan(fourHoursThirtySevenMinutes);
		expect(result.endAction).toBe("snapcompact");
		expect(result.compactionSummary).toBeDefined();
	});

	it("skips candidates that cannot fit after a wider window already overflowed", async () => {
		const result = await runAutoCompaction({
			compact: () => {
				throw contextOverflowError();
			},
		});

		// An input that overflowed a window of W cannot fit in anything at or
		// below W, so each further attempt must strictly beat every window that
		// already overflowed — the chain climbs, it never spends a doomed request.
		const windows = result.tried.map(model => model.contextWindow ?? 0);
		for (let index = 1; index < windows.length; index++) {
			expect(windows[index]).toBeGreaterThan(Math.max(...windows.slice(0, index)));
		}
		// With the widest model in the catalog reached, there is nothing left to
		// climb to: the walk ends in a handful of attempts, not one per model.
		expect(result.tried.length).toBeLessThan(4);
		expect(result.endAction).toBe("snapcompact");
	});

	it("keeps a credentials failure loud instead of quietly archiving", async () => {
		const result = await runAutoCompaction({
			compact: () => {
				throw authError();
			},
		});

		// Nothing was archived and nothing was summarized: the operator has to
		// hear that their credentials are dead.
		expect(result.compactionSummary).toBeUndefined();
		expect(result.notices.find(message => message.startsWith("no compaction model could summarize"))).toBeUndefined();
		const reported = result.endErrorMessage ?? (result.thrown instanceof Error ? result.thrown.message : "");
		expect(reported).toContain("Compaction requires usable credentials");
		// The raw provider envelope must not leak into the actionable message.
		expect(reported).not.toContain("authentication_error");
	});
});
