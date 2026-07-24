import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore, type UsageHistoryEntry } from "@oh-my-pi/pi-ai";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";
const PROVIDER_KEY = "anthropic:oauth";
const FUTURE_BLOCK_MS = 1_899_999_999_000;
const LATER_BLOCK_MS = FUTURE_BLOCK_MS + 60_000;
const EXPIRED_BLOCK_MS = 1;

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		refresh: `refresh-${suffix}`,
		access: `access-${suffix}`,
		expires: Date.now() + 3_600_000,
	};
}

describe("AuthStorage.providerBlockedUntil", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-provider-blocked-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	/** Open a store, seed `count` OAuth credentials, and return the row ids. */
	async function seed(count: number): Promise<number[]> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		for (let index = 1; index <= count; index++) {
			store.saveOAuth(PROVIDER, oauthCredential(String(index)));
		}
		const ids = store.listAuthCredentials(PROVIDER).map(row => row.id);
		store.close();
		return ids;
	}

	async function withStorage<T>(use: (storage: AuthStorage) => Promise<T> | T): Promise<T> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store);
		await storage.reload();
		try {
			return await use(storage);
		} finally {
			storage.close();
		}
	}

	it("reports a park recorded by a previous process", async () => {
		const ids = await seed(1);
		await withStorage(storage => {
			storage.upsertCredentialBlock({
				credentialId: ids[0]!,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		});

		// A brand-new AuthStorage over the same db — no in-memory backoff at all.
		const blockedUntil = await withStorage(storage => storage.providerBlockedUntil(PROVIDER));
		expect(blockedUntil).toBe(FUTURE_BLOCK_MS);
	});

	it("returns undefined while any credential is still usable", async () => {
		const ids = await seed(2);
		const blockedUntil = await withStorage(storage => {
			storage.upsertCredentialBlock({
				credentialId: ids[0]!,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			return storage.providerBlockedUntil(PROVIDER);
		});
		expect(blockedUntil).toBeUndefined();
	});

	it("reports the earliest expiry once every credential is parked", async () => {
		const ids = await seed(2);
		const blockedUntil = await withStorage(storage => {
			storage.upsertCredentialBlock({
				credentialId: ids[0]!,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: LATER_BLOCK_MS,
			});
			storage.upsertCredentialBlock({
				credentialId: ids[1]!,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			return storage.providerBlockedUntil(PROVIDER);
		});
		expect(blockedUntil).toBe(FUTURE_BLOCK_MS);
	});

	it("ignores an expired park", async () => {
		const ids = await seed(1);
		const blockedUntil = await withStorage(storage => {
			storage.upsertCredentialBlock({
				credentialId: ids[0]!,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: EXPIRED_BLOCK_MS,
			});
			return storage.providerBlockedUntil(PROVIDER);
		});
		expect(blockedUntil).toBeUndefined();
	});

	it("returns undefined for a provider with no credentials", async () => {
		await seed(1);
		const blockedUntil = await withStorage(storage => storage.providerBlockedUntil("provider-with-no-creds"));
		expect(blockedUntil).toBeUndefined();
	});

	/**
	 * Usage account identity for `oauthCredential(suffix)`. Mirrors
	 * `AuthStorage.#buildUsageCacheIdentity`: with no accountId/email/orgId on the
	 * credential it falls back to a hash of the refresh token.
	 */
	function accountKeyFor(suffix: string): string {
		return `oauth|secret:${Bun.hash(`refresh-${suffix}`).toString(16)}`;
	}

	async function recordUsage(entries: UsageHistoryEntry[]): Promise<void> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.recordUsageSnapshots(entries);
		store.close();
	}

	function usageEntry(
		overrides: Partial<UsageHistoryEntry> & Pick<UsageHistoryEntry, "accountKey">,
	): UsageHistoryEntry {
		return {
			recordedAt: Date.now(),
			provider: PROVIDER,
			limitId: `${PROVIDER}:5h`,
			label: "5 hour",
			status: "exhausted",
			usedFraction: 1,
			resetsAt: FUTURE_BLOCK_MS,
			...overrides,
		};
	}

	it("reports a recorded exhausted window that has not reset yet", async () => {
		await seed(1);
		await recordUsage([usageEntry({ accountKey: accountKeyFor("1") })]);
		const blockedUntil = await withStorage(storage => storage.providerBlockedUntil(PROVIDER));
		expect(blockedUntil).toBe(FUTURE_BLOCK_MS);
	});

	it("ignores a recorded exhausted window whose reset already passed", async () => {
		await seed(1);
		await recordUsage([usageEntry({ accountKey: accountKeyFor("1"), resetsAt: EXPIRED_BLOCK_MS })]);
		const blockedUntil = await withStorage(storage => storage.providerBlockedUntil(PROVIDER));
		expect(blockedUntil).toBeUndefined();
	});

	it("ignores a window that is merely warning, not exhausted", async () => {
		await seed(1);
		await recordUsage([usageEntry({ accountKey: accountKeyFor("1"), status: "warning", usedFraction: 0.96 })]);
		const blockedUntil = await withStorage(storage => storage.providerBlockedUntil(PROVIDER));
		expect(blockedUntil).toBeUndefined();
	});

	it("stops holding an exhausted window against a provider once a newer report clears it", async () => {
		await seed(1);
		const accountKey = accountKeyFor("1");
		await recordUsage([usageEntry({ accountKey, recordedAt: Date.now() - 60_000 })]);
		await recordUsage([usageEntry({ accountKey, status: "ok", usedFraction: 0 })]);
		const blockedUntil = await withStorage(storage => storage.providerBlockedUntil(PROVIDER));
		expect(blockedUntil).toBeUndefined();
	});

	it("ignores a report older than the trusted window", async () => {
		await seed(1);
		await recordUsage([usageEntry({ accountKey: accountKeyFor("1"), recordedAt: Date.now() - 25 * 60 * 60_000 })]);
		const blockedUntil = await withStorage(storage => storage.providerBlockedUntil(PROVIDER));
		expect(blockedUntil).toBeUndefined();
	});

	it("stays usable while only one of two credentials is exhausted", async () => {
		await seed(2);
		await recordUsage([usageEntry({ accountKey: accountKeyFor("1") })]);
		const blockedUntil = await withStorage(storage => storage.providerBlockedUntil(PROVIDER));
		expect(blockedUntil).toBeUndefined();
	});

	it("takes the later of a credential block and a recorded exhaustion", async () => {
		const ids = await seed(1);
		await recordUsage([usageEntry({ accountKey: accountKeyFor("1"), resetsAt: LATER_BLOCK_MS })]);
		const blockedUntil = await withStorage(storage => {
			storage.upsertCredentialBlock({
				credentialId: ids[0]!,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			return storage.providerBlockedUntil(PROVIDER);
		});
		expect(blockedUntil).toBe(LATER_BLOCK_MS);
	});
});
