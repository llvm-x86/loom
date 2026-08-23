import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Mnemopi } from "../src";

/**
 * One bank file, many processes.
 *
 * This is not a synthetic stress shape: memory banks are keyed on the
 * REPOSITORY, so a parallel batch of task subagents all retain into the SAME
 * bank file. Each subagent used to get a private file (named after its own run
 * directory) and could never collide with a peer, which is exactly why the
 * write path was never hardened against contention.
 *
 * It has to be cross-PROCESS to be meaningful. In-process writers share Bun's
 * sqlite and pass this trivially even with every lock fix reverted; the
 * failures only appear once independent processes contend for the write lock.
 *
 * SCOPE, honestly: this reproduces the real shape but it is timing-dependent
 * and NOT a reliable detector -- whether a run collides depends on how the OS
 * interleaves the writers, and it passed against the unfixed code 4/4 on a
 * tmpfs-backed /tmp. `bank-lock-contention.test.ts` holds a real lock and
 * fails deterministically; that file is the guard. This one is kept because
 * it exercises the whole stack (open, migrate, insert) in the shape production
 * actually produces, which is how the following were originally found:
 *  - `PRAGMA journal_mode=WAL` throwing on a fresh bank, because a
 *    journal-mode change needs an exclusive lock and SQLite may report
 *    SQLITE_BUSY for it WITHOUT invoking the busy handler, so `busy_timeout`
 *    never applies.
 *  - per-statement schema DDL (`initBeam`, `EpisodicGraph`, annotations)
 *    failing the same way while a peer held a read snapshot.
 *  - `remember`'s bare INSERT losing a row outright to SQLITE_BUSY.
 * Each one killed a whole writer, losing every row it had yet to write.
 */
describe("concurrent cross-process writers on one bank", () => {
	const WRITERS = 12;
	const PER_WRITER = 25;

	it("loses no rows when many processes open and write one bank at once", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "mnemopi-conc-"));
		try {
			const dbPath = path.join(root, "mnemopi.db");
			// Spawned rather than imported on purpose: see the note above.
			const workerPath = path.join(root, "writer.ts");
			writeFileSync(
				workerPath,
				`import { Mnemopi } from ${JSON.stringify(path.resolve(import.meta.dir, "../src"))};
const [dbPath, tag, count] = [process.argv[2], process.argv[3], Number(process.argv[4])];
const memory = new Mnemopi({ sessionId: tag, bank: "shared-bank", dbPath, noEmbeddings: true });
const failures = [];
for (let i = 0; i < count; i++) {
	try {
		memory.remember(\`row \${tag} \${i}\`, { importance: 0.5 });
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}
}
memory.close();
console.log(JSON.stringify({ tag, failures }));
`,
			);

			const spawned = Array.from({ length: WRITERS }, (_, i) =>
				Bun.spawn(["bun", "run", workerPath, dbPath, `w${i}`, String(PER_WRITER)], {
					stdout: "pipe",
					stderr: "pipe",
				}),
			);
			const results = await Promise.all(
				spawned.map(async child => ({
					code: await child.exited,
					stdout: await new Response(child.stdout).text(),
					stderr: await new Response(child.stderr).text(),
				})),
			);

			// A writer that dies mid-way takes every row it had left with it, so
			// assert on the exit status and the reported failures before the
			// count -- they say WHY rows are missing, which a bare count cannot.
			const crashed = results.filter(result => result.code !== 0);
			expect(crashed.map(result => result.stderr.split("\n")[0])).toEqual([]);
			const reportedFailures = results.flatMap(result => {
				const line = result.stdout.trim().split("\n").pop() ?? "{}";
				const parsed: unknown = JSON.parse(line);
				return parsed && typeof parsed === "object" && "failures" in parsed ? (parsed.failures as string[]) : [];
			});
			expect(reportedFailures).toEqual([]);

			const verify = new Mnemopi({ sessionId: "verify", bank: "shared-bank", dbPath, noEmbeddings: true });
			try {
				const rows = verify.db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM working_memory").get();
				const sessions = verify.db
					.query<{ total: number }, []>("SELECT COUNT(DISTINCT session_id) AS total FROM working_memory")
					.get();
				expect(rows?.total).toBe(WRITERS * PER_WRITER);
				// Every writer must be represented: a uniform shortfall would
				// otherwise hide one silently dead process.
				expect(sessions?.total).toBe(WRITERS);
			} finally {
				verify.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
