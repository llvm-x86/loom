/**
 * Session account pin (`/account` picker) contract:
 * `setSessionCredentialPin` must make `getApiKey` resolve to the pinned
 * credential even when usage-based ranking would otherwise favour a
 * healthier sibling, and `clearSessionCredentialPin` must restore ranking.
 * A pin must also outlive the Anthropic-only warm-idle window that would
 * otherwise cause an ordinary sticky to re-rank.
 *
 * Without the pin, `getApiKey` would round-robin/rank between credentials
 * and could silently drift the session away from the account the user
 * explicitly chose.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";

function createCredential(accountId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		email,
	};
}

function createClaudeLimit(key: "5h" | "7d", durationMs: number, usedFraction: number): UsageLimit {
	const clamped = Math.min(Math.max(usedFraction, 0), 1);
	const used = clamped * 100;
	const label = key === "5h" ? "Claude 5 Hour" : "Claude 7 Day";
	return {
		id: `anthropic:${key}`,
		label,
		scope: { provider: "anthropic", windowId: key, shared: true },
		window: { id: key, label, durationMs, resetsAt: Date.now() + durationMs },
		amount: {
			unit: "percent",
			used,
			limit: 100,
			remaining: 100 - used,
			usedFraction: clamped,
			remainingFraction: Math.max(0, 1 - clamped),
		},
		status: clamped >= 1 ? "exhausted" : clamped >= 0.9 ? "warning" : "ok",
	};
}

function createClaudeReport(accountId: string, primaryUsedFraction: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [createClaudeLimit("5h", FIVE_HOUR_MS, primaryUsedFraction), createClaudeLimit("7d", WEEK_MS, 0.1)],
		metadata: { accountId },
	};
}

describe("AuthStorage session account pin", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "anthropic",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-session-pin-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials.anthropic as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("pin overrides usage ranking for the session, unpin restores ranking", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-hot", "hot@example.com") },
			{ type: "oauth", ...createCredential("acct-fresh", "fresh@example.com") },
		]);
		usageByAccount.set("acct-hot", createClaudeReport("acct-hot", 0.95));
		usageByAccount.set("acct-fresh", createClaudeReport("acct-fresh", 0.05));

		const rows = authStorage.listStoredCredentials("anthropic");
		const hotId = rows.find(r => r.credential.type === "oauth" && r.credential.accountId === "acct-hot")!.id;

		const sessionId = "session-pin-test";
		// Baseline: ranking should prefer the fresher account absent a pin.
		const unpinnedKey = await authStorage.getApiKey("anthropic", sessionId, {});
		expect(unpinnedKey).toBe("api-acct-fresh");

		// Pin the (worse-ranked) hot account explicitly.
		const pinnedIndex = authStorage.setSessionCredentialPin("anthropic", sessionId, hotId);
		expect(pinnedIndex).toBeDefined();

		const pinnedKey = await authStorage.getApiKey("anthropic", sessionId, {});
		expect(pinnedKey).toBe("api-acct-hot");

		// Unknown credential id is rejected without disturbing the existing pin.
		const badPin = authStorage.setSessionCredentialPin("anthropic", sessionId, 999_999);
		expect(badPin).toBeUndefined();
		const stillPinnedKey = await authStorage.getApiKey("anthropic", sessionId, {});
		expect(stillPinnedKey).toBe("api-acct-hot");

		// Clearing the pin restores usage-based ranking.
		authStorage.clearSessionCredentialPin("anthropic", sessionId);
		const restoredKey = await authStorage.getApiKey("anthropic", sessionId, {});
		expect(restoredKey).toBe("api-acct-fresh");
	});

	test("pin persists across AuthStorage instances via the sticky cache", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-hot", "hot@example.com") },
			{ type: "oauth", ...createCredential("acct-fresh", "fresh@example.com") },
		]);
		usageByAccount.set("acct-hot", createClaudeReport("acct-hot", 0.95));
		usageByAccount.set("acct-fresh", createClaudeReport("acct-fresh", 0.05));

		const rows = authStorage.listStoredCredentials("anthropic");
		const hotId = rows.find(r => r.credential.type === "oauth" && r.credential.accountId === "acct-hot")!.id;
		const sessionId = "session-pin-persist";
		authStorage.setSessionCredentialPin("anthropic", sessionId, hotId);

		// Fresh AuthStorage instance over the same store simulates a process restart.
		const restarted = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		});
		await restarted.reload();
		const key = await restarted.getApiKey("anthropic", sessionId, {});
		expect(key).toBe("api-acct-hot");
	});

	test("pinned sticky survives past the Anthropic warm-idle window; plain sticky does not", async () => {
		if (!authStorage || !store) throw new Error("test setup failed");

		await authStorage.set("anthropic", [
			{ type: "oauth", ...createCredential("acct-hot", "hot@example.com") },
			{ type: "oauth", ...createCredential("acct-fresh", "fresh@example.com") },
		]);
		usageByAccount.set("acct-hot", createClaudeReport("acct-hot", 0.95));
		usageByAccount.set("acct-fresh", createClaudeReport("acct-fresh", 0.05));

		const rows = authStorage.listStoredCredentials("anthropic");
		const hotRow = rows.find(r => r.credential.type === "oauth" && r.credential.accountId === "acct-hot")!;

		const staleLastUsedAtMs = Date.now() - 2 * HOUR_MS; // past the 60-minute warm window

		const pinnedSessionId = "session-pin-stale";
		store.setCache(
			`${SESSION_STICKY_CACHE_PREFIX}anthropic:${pinnedSessionId}`,
			JSON.stringify({
				type: "oauth",
				index: 0,
				credentialId: hotRow.id,
				lastUsedAtMs: staleLastUsedAtMs,
				pinned: true,
			}),
			Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
		);

		const plainSessionId = "session-sticky-stale";
		store.setCache(
			`${SESSION_STICKY_CACHE_PREFIX}anthropic:${plainSessionId}`,
			JSON.stringify({
				type: "oauth",
				index: 0,
				credentialId: hotRow.id,
				lastUsedAtMs: staleLastUsedAtMs,
			}),
			Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
		);

		const restarted = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
		});
		await restarted.reload();

		// A user pin ignores the idle-warm window and keeps the explicitly chosen account.
		const pinnedKey = await restarted.getApiKey("anthropic", pinnedSessionId, {});
		expect(pinnedKey).toBe("api-acct-hot");

		// A plain (non-pinned) sticky past the warm window re-ranks to the healthier sibling.
		const plainKey = await restarted.getApiKey("anthropic", plainSessionId, {});
		expect(plainKey).toBe("api-acct-fresh");
	});
});
