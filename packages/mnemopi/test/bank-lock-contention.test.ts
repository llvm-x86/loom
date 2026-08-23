import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { openDatabase, transaction } from "../src/db";

/**
 * Deterministic counterparts to `concurrent-bank-writers.test.ts`.
 *
 * That test reproduces the real SHAPE -- N processes, one bank -- but it is
 * timing-dependent: whether a given run collides depends on how the OS
 * interleaves the writers, and it passes against the unfixed code often
 * enough to be worthless as a guard. These provoke the two specific lock
 * failures directly, so they fail on the unfixed code every time.
 *
 * Both matter because banks are keyed on the REPOSITORY: a parallel batch of
 * task subagents shares one bank file, where each subagent used to get a
 * private file named after its own run directory and could never contend.
 */
describe("bank writes under a held lock", () => {
	/**
	 * Hold the write lock from a CHILD process for `holdMs`, then release.
	 * A child, not another connection here, because the retry that has to be
	 * exercised is synchronous (`Bun.sleepSync`) and would block an in-process
	 * timer from ever firing -- the lock would never be released and both the
	 * fixed and unfixed code would fail, proving nothing.
	 */
	function spawnLockHolder(dbPath: string, holdMs: number) {
		const script = path.join(path.dirname(dbPath), "lock-holder.ts");
		writeFileSync(
			script,
			`import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { create: true, readwrite: true });
db.exec("PRAGMA busy_timeout=5000");
db.exec("PRAGMA journal_mode=WAL");
db.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, note TEXT)");
db.exec("BEGIN IMMEDIATE");
db.run("INSERT INTO probe (note) VALUES ('held')");
console.log("locked");
Bun.sleepSync(Number(process.argv[3]));
db.exec("COMMIT");
db.close();
`,
		);
		return Bun.spawn(["bun", "run", script, dbPath, String(holdMs)], { stdout: "pipe", stderr: "pipe" });
	}

	it("waits out a peer holding the write lock instead of failing the write", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-lock-"));
		try {
			const dbPath = path.join(root, "bank.db");
			// Seed the file so the holder and the writer agree on the schema.
			const seed = openDatabase(dbPath);
			seed.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, note TEXT)");
			seed.close();

			const holder = spawnLockHolder(dbPath, 400);
			// Wait for the lock to actually be held: without this the test could
			// race ahead and measure an uncontended write.
			const reader = holder.stdout.getReader();
			const firstChunk = await reader.read();
			expect(new TextDecoder().decode(firstChunk.value)).toContain("locked");

			const db = openDatabase(dbPath);
			try {
				// Read THEN write, which is what makes a deferred transaction
				// upgrade its lock mid-flight. SQLite fails that upgrade with
				// SQLITE_BUSY immediately and without invoking the busy handler,
				// so `busy_timeout` does not cover it: before the fix this threw
				// "database is locked" the instant the holder was live.
				transaction(db, () => {
					db.query("SELECT COUNT(*) AS total FROM probe").get();
					db.run("INSERT INTO probe (note) VALUES ('writer')");
				});
				const rows = db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM probe").get();
				// The holder's row plus ours: the write landed, it was not merely
				// swallowed.
				expect(rows?.total).toBe(2);
			} finally {
				db.close();
				await holder.exited;
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("opens a bank whose journal mode cannot be changed right now", () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-wal-"));
		try {
			const dbPath = path.join(root, "bank.db");
			// A bank NOT in WAL, so opening it wants to change the journal mode.
			const owner = new Database(dbPath, { create: true, readwrite: true });
			owner.exec("PRAGMA journal_mode=DELETE");
			owner.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
			// Hold a read snapshot: a journal-mode change needs exclusive access,
			// so while this is open the change cannot be made.
			owner.exec("BEGIN DEFERRED");
			owner.query("SELECT COUNT(*) FROM probe").get();

			try {
				// Must not throw. WAL is a concurrency optimisation, not a
				// correctness requirement, so a bank that cannot be switched
				// right now still has to open and be usable -- before the fix
				// this threw and took the whole session's memory with it.
				const startedAt = Bun.nanoseconds();
				const db = openDatabase(dbPath);
				// And it must not STALL either: opening a bank sits in front of
				// an agent's turn. The retry once inherited the full 5s
				// busy_timeout per attempt and took 25 seconds.
				const elapsedMs = (Bun.nanoseconds() - startedAt) / 1e6;
				expect(elapsedMs).toBeLessThan(5_000);
				try {
					db.query("SELECT COUNT(*) AS total FROM probe").get();
					const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
					expect(typeof mode?.journal_mode).toBe("string");
				} finally {
					db.close();
				}
			} finally {
				owner.exec("ROLLBACK");
				owner.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
