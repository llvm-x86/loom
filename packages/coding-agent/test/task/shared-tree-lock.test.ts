import { describe, expect, it } from "bun:test";
import { activeSharedTreeLockCount, withSharedTreeLock } from "@oh-my-pi/pi-coding-agent/task/shared-tree-lock";

/** Alias kept short: every case needs a gate it can open at a chosen moment. */
const gate = () => Promise.withResolvers<void>();

describe("shared tree lock", () => {
	it("does not start a second body for the same tree while the first is running", async () => {
		const first = gate();
		const order: string[] = [];

		const a = withSharedTreeLock("/repo", async () => {
			order.push("a:start");
			await first.promise;
			order.push("a:end");
		});
		const b = withSharedTreeLock("/repo", async () => {
			order.push("b:start");
		});

		// Give both a chance to run: only `a` may have entered its body.
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["a:start"]);

		first.resolve();
		await Promise.all([a, b]);
		expect(order).toEqual(["a:start", "a:end", "b:start"]);
	});

	it("runs different trees concurrently", async () => {
		const blocker = gate();
		const order: string[] = [];

		const a = withSharedTreeLock("/repo-a", async () => {
			order.push("a:start");
			await blocker.promise;
		});
		const b = withSharedTreeLock("/repo-b", async () => {
			order.push("b:start");
		});

		await b;
		// `b` finished while `a` is still holding its own, different key.
		expect(order).toEqual(["a:start", "b:start"]);
		blocker.resolve();
		await a;
	});

	it("releases the lock when a body throws, and does not poison the queue", async () => {
		const ran: string[] = [];

		const failing = withSharedTreeLock("/repo", async () => {
			ran.push("failing");
			throw new Error("subagent blew up");
		});
		const next = withSharedTreeLock("/repo", async () => {
			ran.push("next");
			return "ok";
		});

		await expect(failing).rejects.toThrow("subagent blew up");
		expect(await next).toBe("ok");
		expect(ran).toEqual(["failing", "next"]);
	});

	it("forgets a tree once its last holder finishes", async () => {
		await withSharedTreeLock("/transient", async () => {});
		expect(activeSharedTreeLockCount()).toBe(0);
	});

	it("preserves arrival order across a burst on one tree", async () => {
		const hold = gate();
		const seen: number[] = [];
		const spawns = [0, 1, 2, 3, 4].map(i =>
			withSharedTreeLock("/burst", async () => {
				if (i === 0) await hold.promise;
				seen.push(i);
			}),
		);

		hold.resolve();
		await Promise.all(spawns);
		expect(seen).toEqual([0, 1, 2, 3, 4]);
		expect(activeSharedTreeLockCount()).toBe(0);
	});
});
