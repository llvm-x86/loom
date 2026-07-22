/**
 * Contracts: `reportContextActivity` — fire-and-forget Context Activity event POST.
 *
 * 1. Never awaited by the caller: the function returns synchronously even
 *    while the underlying fetch is still pending.
 * 2. Swallows all errors (endpoint down / rejects) — never throws, never
 *    produces an unhandled rejection.
 * 3. Posts JSON to `<reportUrl>/api/context/event`.
 * 4. Empty `reportUrl` is a no-op — no fetch call at all.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { reportContextActivity } from "@oh-my-pi/pi-coding-agent/utils/context-activity-reporter";

function mockFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
	return Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

function baseEvent() {
	return {
		id: "activity-1",
		kind: "sync" as const,
		phase: "start" as const,
		session_id: "session-1",
		trigger: "idle" as const,
		ts: Date.now(),
	};
}

describe("reportContextActivity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is fire-and-forget: returns before the pending fetch resolves", () => {
		const gate = Promise.withResolvers<Response>();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch(() => gate.promise));

		expect(() => reportContextActivity(baseEvent(), "http://127.0.0.1:8811")).not.toThrow();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:8811/api/context/event");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body)).id).toBe("activity-1");

		gate.resolve(new Response("{}", { status: 200 }));
	});

	it("never throws and never surfaces an unhandled rejection when the endpoint is down", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch(() => Promise.reject(new Error("ECONNREFUSED"))));

		expect(() => reportContextActivity(baseEvent(), "http://127.0.0.1:8811")).not.toThrow();

		// Let the rejected fetch's `.catch(() => undefined)` settle; an
		// unswallowed rejection would surface here as a test-process warning
		// or, with bun's strict mode, a failure.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});

	it("no-ops (no fetch call) when reportUrl is empty", () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(mockFetch(() => Promise.resolve(new Response("{}"))));

		reportContextActivity(baseEvent(), "");

		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
