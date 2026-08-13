import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "./config";

export type DatabasePath = string | ":memory:";

export interface OpenDatabaseOptions {
	readonly create?: boolean;
	readonly readwrite?: boolean;
	readonly strict?: boolean;
	readonly loadExtension?: string | readonly string[];
	readonly pragmas?: boolean;
}

interface TxState {
	depth: number;
}

const TX_STATE = Symbol("mnemopi.txState");

type TxDatabase = Database & { [TX_STATE]?: TxState };
type ExtensionDatabase = Database & { loadExtension(path: string): void };

export function openDatabase(path: DatabasePath = dbPath(), options: OpenDatabaseOptions = {}): Database {
	// Everything SQLite creates -- the db, and the `-wal`/`-shm` it recreates
	// per connection -- is masked by the process umask, so the relaxed umask
	// has to stay in force until the WAL pragma has run. No `await` happens in
	// between, so this never leaks into unrelated work.
	const previousUmask = path === ":memory:" ? undefined : relaxUmaskForSharedStore(dirname(path));
	try {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path, {
			create: options.create ?? true,
			readwrite: options.readwrite ?? true,
			strict: options.strict ?? true,
		});
		if (options.pragmas !== false) enablePragmas(db, path);
		if (path !== ":memory:" && previousUmask !== undefined) shareExistingFiles(path);
		if (options.loadExtension !== undefined) loadExtensions(db, options.loadExtension);
		return db;
	} finally {
		if (previousUmask !== undefined) process.umask(previousUmask);
	}
}

/**
 * Drop the group bits from the umask when this store is meant to be shared,
 * returning the previous umask (or undefined when it is not shared).
 *
 * A repo-keyed bank is one GitHub repository, not one Linux account: every
 * account working that repo is meant to open the SAME database. Operators
 * express that by putting the store on a group-writable setgid directory, but
 * setgid propagates the GROUP and not the write BIT, so under the usual 022
 * umask the first account to touch a bank creates 0755 dirs and 0644 files
 * and silently locks every other account out of memories they are supposed to
 * share. The directory matters as much as the file: SQLite recreates
 * `-wal`/`-shm` per connection, so a peer that cannot create the sidecars
 * cannot open a WAL bank at all.
 *
 * Done with the umask rather than a chmod afterwards for two reasons. It is
 * race-free -- the files are never briefly private -- and, decisively,
 * `fs.chmodSync` under Bun silently drops the setgid bit (0o2775 lands as
 * 0775, verified on Bun 1.3), which would break group inheritance for every
 * directory below the root. Letting the kernel inherit setgid through
 * `mkdir` keeps it intact.
 *
 * Shared-ness is judged on the deepest ALREADY-EXISTING ancestor. Walking
 * further up looking for "some" group-writable ancestor would be wrong:
 * `/tmp` is 1777, so every private 0700 directory beneath it would qualify.
 */
function relaxUmaskForSharedStore(dir: string): number | undefined {
	let anchor = dir;
	while (!existsSync(anchor)) {
		const parent = dirname(anchor);
		if (parent === anchor) return undefined;
		anchor = parent;
	}
	try {
		if ((statSync(anchor).mode & 0o020) === 0) return undefined;
	} catch {
		return undefined;
	}
	return process.umask(0o002);
}

/**
 * Widen a database that predates its move onto a shared root. Files created
 * under the relaxed umask above are already group-writable; this only rescues
 * one migrated in at 0644. SQLite derives `-wal`/`-shm` permissions from the
 * database file, so fixing the db is what fixes the sidecars.
 */
function shareExistingFiles(path: string): void {
	for (const file of [path, `${path}-wal`, `${path}-shm`]) {
		try {
			const mode = statSync(file).mode & 0o7777;
			if ((mode & 0o060) !== 0o060) chmodSync(file, mode | 0o060);
		} catch {
			// Absent (no WAL yet), or owned by a peer that already shared it.
		}
	}
}

export function enablePragmas(db: Database, path?: DatabasePath): void {
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
}

export function loadExtensions(db: Database, extensions: string | readonly string[]): void {
	if (typeof extensions === "string") {
		if (extensions) (db as ExtensionDatabase).loadExtension(extensions);
		return;
	}
	for (const extension of extensions) {
		if (extension) (db as ExtensionDatabase).loadExtension(extension);
	}
}

export function transaction<T>(db: Database, fn: () => T): T {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return fn();
		} finally {
			state.depth--;
		}
	}

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export const deferredTransaction = transaction;

export async function transactionAsync<T>(db: Database, fn: () => Promise<T>): Promise<T> {
	const txDb = db as TxDatabase;
	let state = txDb[TX_STATE];
	if (state !== undefined && state.depth > 0) {
		state.depth++;
		try {
			return await fn();
		} finally {
			state.depth--;
		}
	}

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	db.exec("BEGIN DEFERRED");
	try {
		const result = await fn();
		state.depth = 0;
		db.exec("COMMIT");
		return result;
	} catch (error) {
		state.depth = 0;
		try {
			db.exec("ROLLBACK");
		} catch {
			// Preserve the original error; rollback can fail if SQLite already closed the transaction.
		}
		throw error;
	} finally {
		delete txDb[TX_STATE];
	}
}

export function closeQuietly(db: Database | undefined | null): void {
	if (db === undefined || db === null) return;
	try {
		db.close();
	} catch {
		// Best-effort cleanup.
	}
}
