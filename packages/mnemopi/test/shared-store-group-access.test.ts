import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";

/**
 * A repo-keyed bank is one GitHub repository, not one Linux account. When the
 * store sits on a group-writable (setgid) root, every account working that
 * repo must be able to WRITE the bank — including the `-wal`/`-shm` files
 * SQLite recreates per connection, and the directory it creates them in.
 * A private per-account store must keep its narrow permissions.
 */
describe("shared bank store group access", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mnemopi-share-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const mode = (path: string) => statSync(path).mode & 0o7777;

	// `fs.chmodSync` under Bun silently drops the setgid bit -- the very bug
	// that makes the production code use a relaxed umask instead of a chmod.
	// The fixture therefore cannot use it to build a setgid root either.
	const makeSharedRoot = (dir: string) => {
		mkdirSync(dir, { recursive: true });
		const chmod = Bun.spawnSync(["chmod", "2775", dir]);
		if (chmod.exitCode !== 0) throw new Error(`chmod 2775 ${dir} failed`);
	};

	test("a bank under a group-writable root becomes group-writable", () => {
		const shared = join(root, "shared");
		makeSharedRoot(shared);

		const db = openDatabase(join(shared, "mnemopi", "banks", "llvm-x86-agent-chat", "mnemopi.db"));
		db.close();

		const bank = join(shared, "mnemopi", "banks", "llvm-x86-agent-chat");
		// Every level mkdir created below the shared root, not just the last.
		expect(mode(join(shared, "mnemopi")) & 0o070).toBe(0o070);
		expect(mode(join(shared, "mnemopi", "banks")) & 0o070).toBe(0o070);
		expect(mode(bank) & 0o070).toBe(0o070);
		// The db itself, so a peer account can open it read-write.
		expect(mode(join(bank, "mnemopi.db")) & 0o060).toBe(0o060);
		// setgid must survive on every created level: it is what makes a file
		// written by ANOTHER account land in the shared group instead of that
		// account's primary group. `fs.chmodSync` under Bun drops this bit, so
		// the directories are created under a relaxed umask rather than
		// chmod'ed afterwards.
		expect(mode(join(shared, "mnemopi")) & 0o2000).toBe(0o2000);
		expect(mode(join(shared, "mnemopi", "banks")) & 0o2000).toBe(0o2000);
		expect(mode(bank) & 0o2000).toBe(0o2000);
		// The bank inherited the root's group, which is the point of setgid.
		expect(statSync(bank).gid).toBe(statSync(shared).gid);
	});

	test("WAL sidecars are shared too, not just the database file", () => {
		const shared = join(root, "shared");
		makeSharedRoot(shared);
		const dbFile = join(shared, "banks", "repo", "mnemopi.db");

		const db = openDatabase(dbFile);
		// Force the sidecars into existence, and assert while the connection is
		// open: SQLite checkpoints and unlinks `-wal` on a clean close.
		db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
		db.exec("INSERT INTO probe (id) VALUES (1)");

		expect(mode(`${dbFile}-wal`) & 0o060).toBe(0o060);
		expect(mode(`${dbFile}-shm`) & 0o060).toBe(0o060);
		db.close();
	});

	test("a private store keeps its permissions", () => {
		const priv = join(root, "private");
		mkdirSync(priv, { recursive: true });
		chmodSync(priv, 0o700);
		const bank = join(priv, "banks", "repo");

		const db = openDatabase(join(bank, "mnemopi.db"));
		db.close();

		// No group-writable ancestor: nothing was widened.
		expect(mode(bank) & 0o020).toBe(0o000);
		expect(mode(join(bank, "mnemopi.db")) & 0o020).toBe(0o000);
	});
});
