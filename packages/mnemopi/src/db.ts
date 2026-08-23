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

type TxDatabase = Database & { [TX_STATE]?: TxState; inTransaction?: boolean; in_transaction?: boolean };
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

/** Attempts to move a bank into WAL, and the first backoff step between them. */
const WAL_PRAGMA_ATTEMPTS = 5;
const WAL_PRAGMA_BACKOFF_MS = 20;
/**
 * Wait cap while probing/setting the journal mode, kept far below the
 * steady-state `BUSY_TIMEOUT_MS`. Opening a bank sits in front of an agent's
 * turn, and the full timeout applies to EVERY attempt: with the normal 5s
 * ceiling, five attempts against a bank that cannot switch mode right now
 * stalled the open for 25 seconds (measured). Failing this probe is cheap --
 * the bank opens in whatever journal mode it already has -- so it gets a
 * short leash and the real timeout is installed once the probe is done.
 */
const WAL_PROBE_TIMEOUT_MS = 250;
const BUSY_TIMEOUT_MS = 5000;

export function enablePragmas(db: Database, path?: DatabasePath): void {
	db.exec("PRAGMA foreign_keys=ON");
	if (path !== ":memory:") {
		db.exec(`PRAGMA busy_timeout=${WAL_PROBE_TIMEOUT_MS}`);
		enableWalMode(db);
	}
	db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
}

/**
 * WAL is a PERSISTENT property of the database file, so only a connection
 * that finds the bank in some OTHER mode has to change it -- and that change
 * takes an exclusive lock which `busy_timeout` does not reliably cover:
 * SQLite can return SQLITE_BUSY for a journal_mode change without ever
 * invoking the busy handler. Reading the mode first is therefore what keeps
 * the common case lock-free -- N peers opening an already-WAL bank never
 * contend at all, because none of them tries to set anything.
 *
 * The race that remains is a BRAND-NEW bank opened by several processes at
 * once: one repo-keyed bank plus a parallel batch of task subagents, which
 * is now the ordinary shape of a fan-out (before banks were keyed on the
 * repo, each subagent had its own file and could never collide). There we
 * retry briefly, and if the mode still will not budge we keep whatever
 * journal mode we have. WAL buys read/write concurrency; it is not required
 * for correctness, and losing a whole subagent's retained memory to an
 * uncaught SQLiteError at construction is strictly worse than letting that
 * one connection run in rollback-journal mode.
 */
function enableWalMode(db: Database): void {
	for (let attempt = 0; ; attempt++) {
		try {
			const row = db.query<{ journal_mode?: string }, []>("PRAGMA journal_mode").get();
			if (row && typeof row.journal_mode === "string" && row.journal_mode.toLowerCase() === "wal") return;
			db.exec("PRAGMA journal_mode=WAL");
			return;
		} catch {
			if (attempt >= WAL_PRAGMA_ATTEMPTS - 1) return;
			Bun.sleepSync(WAL_PRAGMA_BACKOFF_MS * 2 ** attempt);
		}
	}
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

/**
 * How a top-level transaction opens.
 *
 * `BEGIN DEFERRED` takes no lock until the first statement, so a transaction
 * that reads and then writes must UPGRADE to the write lock mid-flight -- and
 * if a peer wrote in between, SQLite fails that upgrade with SQLITE_BUSY
 * immediately, WITHOUT invoking the busy handler. `busy_timeout` therefore
 * does not cover it and the caller sees a bare "database is locked" throw.
 * `BEGIN IMMEDIATE` takes the write lock up front, which is exactly the wait
 * the timeout does cover.
 *
 * Deferred was survivable while every writer had its own bank file. Keying
 * banks on the repository put a whole parallel batch of task subagents on one
 * file, which turned this from theoretical into a measured, reproducible loss
 * of an entire subagent's retained memory. Read-only callers can still opt
 * out via {@link deferredTransaction}; in WAL a write lock never blocks
 * readers, so the cost of defaulting to it is bounded to writer-vs-writer.
 */
const BEGIN_WRITE = "BEGIN IMMEDIATE";

/** Bounded retry for acquiring a transaction: ~1.3s of jittered waiting. */
const BEGIN_ATTEMPTS = 7;
const BEGIN_BACKOFF_MS = 20;

/**
 * Acquire a transaction, waiting out a peer that holds the write lock.
 *
 * `busy_timeout` alone is not enough for a fan-out. It is a per-attempt
 * ceiling, and a bank shared by a parallel batch of task subagents can hold
 * the write lock in sequence for longer than any single wait we would want to
 * hard-code -- each writer's `remember` transaction is short, but N of them
 * queue. Measured on a 24-writer fresh bank, a bare `BEGIN` lost whole
 * subagents' worth of rows to `SQLITE_BUSY`.
 *
 * Retrying is safe precisely HERE and not later: the transaction has not
 * begun, so no statement in `fn` has run and there is nothing to undo. A
 * failure after `BEGIN` still propagates untouched. Backoff is jittered
 * because the losers of one race would otherwise retry in lockstep and
 * collide again -- with 24 peers, synchronized retries are the whole problem.
 */
function beginWithRetry(db: Database, begin: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			db.exec(begin);
			return;
		} catch (error) {
			if (attempt >= BEGIN_ATTEMPTS - 1 || !isBusyError(error)) throw error;
			const ceiling = BEGIN_BACKOFF_MS * 2 ** attempt;
			Bun.sleepSync(ceiling / 2 + Math.random() * (ceiling / 2));
		}
	}
}

/**
 * SQLITE_BUSY/SQLITE_LOCKED, matched on the message because `bun:sqlite`
 * surfaces the code only as text. Anything else -- a constraint violation, a
 * corrupt page -- must NOT be retried: it will fail identically every time
 * and retrying only delays the real error.
 */
function isBusyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

/**
 * True when this connection already has a transaction open, INCLUDING one
 * started by a bare `BEGIN` elsewhere in the codebase, which the `TX_STATE`
 * bookkeeping cannot see. `bun:sqlite` answers this directly; the snake_case
 * spelling is accepted too so a connection shared with
 * `veracity-consolidation`'s `serializedWrite` reads consistently.
 *
 * Without this, wrapping a schema init in a transaction broke the E6
 * migration: it opens its own `BEGIN IMMEDIATE`, calls the init inside it,
 * and SQLite refused the inner `BEGIN` with "cannot start a transaction
 * within a transaction". Asking SQLite instead of trusting our own symbol is
 * what makes the helper safe to introduce anywhere.
 */
function inTransaction(db: Database): boolean {
	const txDb = db as TxDatabase;
	if (txDb.inTransaction === true || txDb.in_transaction === true) return true;
	return (txDb[TX_STATE]?.depth ?? 0) > 0;
}

function runInTransaction<T>(db: Database, fn: () => T, begin: string): T {
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
	// An outer transaction we did not open owns the commit; joining it is the
	// only correct move -- SQLite has no real nested transactions.
	if (inTransaction(db)) return fn();

	state = { depth: 1 };
	txDb[TX_STATE] = state;
	beginWithRetry(db, begin);
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

export function transaction<T>(db: Database, fn: () => T): T {
	return runInTransaction(db, fn, BEGIN_WRITE);
}

/**
 * Explicitly deferred variant, for a transaction known to be READ-ONLY.
 * Deferred is the wrong default for anything that writes (see
 * {@link BEGIN_WRITE}), so this is opt-in rather than the alias it used to
 * be -- a read-only caller pays nothing for the write lock it never needs.
 */
export function deferredTransaction<T>(db: Database, fn: () => T): T {
	return runInTransaction(db, fn, "BEGIN DEFERRED");
}

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
	db.exec(BEGIN_WRITE);
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
