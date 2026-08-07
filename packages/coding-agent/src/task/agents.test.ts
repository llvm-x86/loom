import { describe, expect, it } from "bun:test";
import { loadBundledAgents } from "./agents";

function agent(name: string) {
	const agent = loadBundledAgents().find(a => a.name === name);
	expect(agent, `bundled agent "${name}" should exist`).toBeDefined();
	return agent!;
}

describe("bundled scout agent tool set", () => {
	it("grants the same investigation set as its read-only siblings (reviewer/librarian)", () => {
		const scout = agent("scout");
		const reviewer = agent("reviewer");
		for (const tool of reviewer.tools ?? []) {
			expect(scout.tools).toContain(tool);
		}
		// Explicitly pin the tool that made this test necessary.
		expect(scout.tools).toContain("bash");
	});

	it("keeps the read-only role: no file-write tools", () => {
		const scout = agent("scout");
		expect(scout.tools).not.toContain("write");
		expect(scout.tools).not.toContain("edit");
	});
});
