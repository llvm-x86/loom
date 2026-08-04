import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** Per-line cap small enough that one `printf` trips it deterministically. */
const MAX_COLUMNS = 64;

let tempDir: string;

/**
 * `executeBash` resolves the column cap from the process-global settings, not
 * from the tool session, so the cap has to be pinned there for this file to be
 * independent of the box's `~/.loom` config.
 */
beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-async-notice-"));
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "tools.outputMaxColumns": MAX_COLUMNS } });
});

afterAll(async () => {
	resetSettingsForTest();
	await removeWithRetries(tempDir);
});

function makeSession(manager: AsyncJobManager): ToolSession {
	let artifactCounter = 0;
	return {
		cwd: tempDir,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "async-notice-session",
		getAgentId: () => null,
		asyncJobManager: manager,
		getArtifactsDir: () => tempDir,
		allocateOutputArtifact: async (toolType: string) => {
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(tempDir, `${id}.${toolType}.log`) };
		},
		settings: {
			get(key: string) {
				if (key === "async.enabled") return true;
				// Force the explicit async lane rather than the auto-background
				// foreground wait, which returns the structured result through
				// `execute()` and therefore gets its notice from `wrappedExecute`.
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

describe("bash async lane output notice", () => {
	test("delivers the column-cap notice with the completed background result", async () => {
		// Regression: the async job body flattened the completed result to bare
		// text and shipped that. Notices are appended by `wrappedExecute`, which
		// only wraps `execute()` — a background job resolves long after
		// `execute()` returned its "started" result, so a wide-line command
		// reached the agent with no `Some lines truncated`, no byte count and no
		// artifact id, while the full capture sat on disk unnamed.
		const delivered: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});

		try {
			const tool = new BashTool(makeSession(manager));
			const wideBytes = MAX_COLUMNS * 40;
			const started = await tool.execute("call-async-notice", {
				command: `printf 'X%.0s' $(seq 1 ${wideBytes})`,
				async: true,
			});

			const jobId = started.details?.async?.jobId;
			expect(typeof jobId).toBe("string");
			if (typeof jobId !== "string") throw new Error("missing jobId");

			await waitFor(() => delivered.some(entry => entry.jobId === jobId));
			const deliveredText = delivered.find(entry => entry.jobId === jobId)?.text ?? "";

			// The notice the agent actually receives.
			expect(deliveredText).toContain("Some lines truncated");
			// It names the recoverable capture, otherwise the dropped bytes are
			// unreachable: nothing else in an async delivery cites the artifact.
			expect(deliveredText).toContain("artifact://");
			// The visible body is still the capped line.
			expect(deliveredText).toContain("…");
			// And the job's retained result text carries the same string, so a
			// later `hub`/poll read of the finished job is not a second lane
			// that quietly loses the notice.
			expect(manager.getJob(jobId)?.resultText).toBe(deliveredText);
		} finally {
			await manager.dispose({ timeoutMs: 2_000 });
		}
	}, 30_000);

	test("leaves an un-truncated async result free of a spurious notice", async () => {
		const delivered: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 60_000,
			onJobComplete: (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});

		try {
			const tool = new BashTool(makeSession(manager));
			const started = await tool.execute("call-async-plain", { command: "printf hi", async: true });
			const jobId = started.details?.async?.jobId;
			if (typeof jobId !== "string") throw new Error("missing jobId");

			await waitFor(() => delivered.some(entry => entry.jobId === jobId));
			const deliveredText = delivered.find(entry => entry.jobId === jobId)?.text ?? "";

			expect(deliveredText).toContain("hi");
			expect(deliveredText).not.toContain("Some lines truncated");
			expect(deliveredText).not.toContain("Showing lines");
		} finally {
			await manager.dispose({ timeoutMs: 2_000 });
		}
	}, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("timed out waiting for the async job delivery");
}
