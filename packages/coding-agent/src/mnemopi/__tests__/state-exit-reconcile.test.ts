import { describe, expect, it, spyOn } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { MnemopiSessionState } from "../state";

// Test seam: the hook's private fields and the close handle are only reachable
// at runtime; expose them through one named cast so tests never inline casts.
interface ExitReconcileSeam {
	scoped?: { owned: unknown[] };
	exitReconcileCancel?: () => void;
}

// The shutdown hook only touches the subscribed fields; `scoped`/`memory`
// stay untouched, so a bare prototype instance suffices (same pattern as
// test/agent-session-dispose-concurrent.test.ts). `session`/`aliasOf` are
// readonly on the class, so seed them through Object.assign.
function makeState(): MnemopiSessionState {
	const session = {
		subscribe: () => () => {},
		spoolContextSyncShutdown: () => Promise.resolve(),
	} as unknown as AgentSession;
	return Object.assign(Object.create(MnemopiSessionState.prototype) as MnemopiSessionState, {
		sessionId: "exit-reconcile-test",
		session,
		aliasOf: undefined,
		unsubscribe: () => {},
	});
}

describe("mnemopi session-close hook", () => {
	it("hands the shutdown context off to the worker on a signal teardown", async () => {
		const state = makeState();
		const spool = spyOn(state.session, "spoolContextSyncShutdown").mockResolvedValue(undefined);

		await state.exitReconcile(postmortem.Reason.SIGTERM);

		expect(spool).toHaveBeenCalled();
	});

	it("skips the handoff on a normal exit (dispose spools there)", async () => {
		const state = makeState();
		const spool = spyOn(state.session, "spoolContextSyncShutdown").mockResolvedValue(undefined);

		await state.exitReconcile(postmortem.Reason.EXIT);

		expect(spool).not.toHaveBeenCalled();
	});

	it("skips the handoff once the session disposed (unsubscribe cleared)", async () => {
		const state = makeState();
		state.unsubscribe = undefined; // dispose() clears this before consolidating
		const spool = spyOn(state.session, "spoolContextSyncShutdown").mockResolvedValue(undefined);

		await state.exitReconcile(postmortem.Reason.SIGTERM);

		expect(spool).not.toHaveBeenCalled();
	});

	it("arms the process cleanup hook on attach and unarms it on dispose", async () => {
		const state = makeState();
		const seam = state as unknown as ExitReconcileSeam;
		seam.scoped = { owned: [] };

		state.attachSessionListeners();
		expect(typeof seam.exitReconcileCancel).toBe("function");

		state.dispose({ consolidate: false });
		expect(seam.exitReconcileCancel).toBeUndefined();
		expect(state.unsubscribe).toBeUndefined();
	});
});
