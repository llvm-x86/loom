import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { enforceInlineByteCap } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import { TempDir } from "@oh-my-pi/pi-utils";

const MAX_IN_MEMORY_ARTIFACT_BYTES = 4 * 1024 * 1024;

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("in-memory artifact budget", () => {
	it("reports no artifact for output past the in-memory budget so callers omit a dangling recovery link", async () => {
		const manager = SessionManager.inMemory(makeTempDir("@pi-artifact-budget-cwd-"));
		expect(manager.getArtifactManager()).toBeNull();

		const underBudget = "u".repeat(1024);
		const overBudget = "o".repeat(MAX_IN_MEMORY_ARTIFACT_BYTES + 1);

		expect(await manager.saveArtifact(underBudget, "bash")).toBe("0");
		expect(await manager.saveArtifact(overBudget, "bash")).toBeUndefined();

		// The spill boundary degrades exactly as it does when a file sink cannot be
		// created: bounded inline text, and no `artifact://` link it cannot honour.
		const capped = await enforceInlineByteCap(overBudget, {
			saveArtifact: full => manager.saveArtifact(full, "bash"),
		});
		expect(capped.length).toBeLessThan(overBudget.length);
		expect(capped).not.toContain("artifact://");
	});

	it("still writes file-backed artifacts when the session has an artifacts directory", async () => {
		const cwd = makeTempDir("@pi-artifact-file-cwd-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const overBudget = "o".repeat(MAX_IN_MEMORY_ARTIFACT_BYTES + 1);

		const id = await manager.saveArtifact(overBudget, "bash");
		if (id === undefined) throw new Error("Expected a file-backed artifact id");
		const artifactPath = await manager.getArtifactPath(id);
		if (!artifactPath) throw new Error("Expected a resolvable artifact path");
		expect(await Bun.file(artifactPath).text()).toBe(overBudget);
	});
});
