/**
 * Mutual exclusion for write-capable subagents that end up sharing one working
 * tree.
 *
 * Isolation gives every spawn its own worktree, which is the real fix. But
 * isolation is not always possible — outside a git repository there is nothing
 * to make a worktree from, so an isolation default degrades to running in
 * place. That degradation silently restores the exact hazard isolation exists
 * to prevent: two write-access subagents in one tree, where uncommitted work
 * has no owner and one agent's `git checkout -- .` (or any whole-tree command)
 * reverts the other's edits with nothing failing loudly.
 *
 * When a boundary cannot be enforced in space, enforce it in time: write-capable
 * spawns sharing a directory run one at a time. Read-only agents never queue —
 * they cannot clobber anything, and making scouts wait would serialise the most
 * common fan-out for no safety gain.
 *
 * Scope is deliberately one process. The reported incident is a parent
 * spawning siblings into its own tree, and those siblings are queued here.
 * Cross-process exclusion would need an on-disk lock, whose stale-lock recovery
 * is a worse failure mode than the one being fixed.
 */

/** Tail of the queue per resolved directory; absent key ⇒ nothing running. */
const chains = new Map<string, Promise<void>>();

/**
 * Runs `body` with exclusive access to `key`, resolving to whatever `body`
 * returns. Waiters run in the order they arrive. A rejected body releases the
 * lock and never poisons the queue for the spawns behind it.
 */
export async function withSharedTreeLock<T>(key: string, body: () => Promise<T>): Promise<T> {
	const previous = chains.get(key);
	let release!: () => void;
	const held = new Promise<void>(resolve => {
		release = resolve;
	});
	// Chain onto the previous holder BEFORE awaiting it, so two callers racing
	// in the same tick queue behind each other instead of both seeing an empty
	// chain. `.catch` keeps one failed body from rejecting the shared tail.
	const tail = (previous ?? Promise.resolve()).catch(() => {}).then(() => held);
	chains.set(key, tail);
	if (previous) await previous.catch(() => {});
	try {
		return await body();
	} finally {
		release();
		// Only clear when nobody queued behind us; otherwise the tail is theirs.
		if (chains.get(key) === tail) chains.delete(key);
	}
}

/** Test seam: number of directories with an active or queued holder. */
export function activeSharedTreeLockCount(): number {
	return chains.size;
}
