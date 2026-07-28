import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";

describe("LoomProtocolHandler", () => {
	it("treats loom://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("loom://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("loom://tools/read.md");
		const prefixed = await router.resolve("loom://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});

	it("still resolves the legacy omp:// spelling through the silent alias", async () => {
		const router = InternalUrlRouter.instance();
		const legacy = await router.resolve("omp://tools/read.md");
		const current = await router.resolve("loom://tools/read.md");

		expect(legacy.content).toBe(current.content);
		expect(router.canHandle("omp://tools/read.md")).toBe(true);
	});

	it("keeps the legacy alias out of every user-visible scheme listing", async () => {
		const router = InternalUrlRouter.instance();

		expect(router.completionSchemes()).toContain("loom");
		expect(router.completionSchemes()).not.toContain("omp");
		// Explicit-scheme lookups still work, so callers that name `omp` keep completing.
		expect((await router.complete("omp", ""))?.length ?? 0).toBeGreaterThan(0);
		await expect(router.resolve("nope://x")).rejects.toThrow(/^(?!.*omp:\/\/)[\s\S]*$/);
	});
});
