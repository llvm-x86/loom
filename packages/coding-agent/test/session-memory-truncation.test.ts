import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const MAX_PERSIST_CHARS = 500_000;
const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

/**
 * An assistant turn whose text body is far past `MAX_PERSIST_CHARS`, carrying a
 * signed thinking block, a signed-text block, and a redacted (encrypted)
 * thinking block that are each individually oversized. The signature/encryption
 * payloads are the bytes the provider validates on replay.
 */
function oversizedSignedTurn(): {
	message: AssistantMessage;
	body: string;
	thinking: string;
	thinkingSignature: string;
	signedText: string;
	textSignature: string;
	redacted: string;
} {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const body = "b".repeat(MAX_PERSIST_CHARS + 10_000);
	const thinking = "t".repeat(MAX_PERSIST_CHARS + 10_000);
	const thinkingSignature = "s".repeat(MAX_PERSIST_CHARS + 10_000);
	const signedText = "x".repeat(MAX_PERSIST_CHARS + 10_000);
	const textSignature = "y".repeat(MAX_PERSIST_CHARS + 10_000);
	const redacted = "r".repeat(MAX_PERSIST_CHARS + 10_000);

	return {
		body,
		thinking,
		thinkingSignature,
		signedText,
		textSignature,
		redacted,
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking, thinkingSignature },
				{ type: "redactedThinking", data: redacted },
				{ type: "text", text: signedText, textSignature },
				{ type: "text", text: body },
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as AssistantMessage,
	};
}

function assistantContent(entry: SessionMessageEntry | undefined): AssistantMessage["content"] {
	const message = entry?.message;
	if (message?.role !== "assistant") throw new Error("Expected an assistant entry");
	return message.content;
}

describe("in-memory session truncation parity", () => {
	it("caps the retained entry to the persistence budget and keeps signed blocks byte-identical", async () => {
		const cwd = makeTempDir("@pi-mem-truncation-cwd-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const turn = oversizedSignedTurn();
		manager.appendMessage(turn.message);

		// (1) The live journal — not just the JSONL line — is capped.
		const live = assistantContent(manager.getEntries().at(-1) as SessionMessageEntry);
		const liveUnsignedText = live.find(block => block.type === "text" && block.textSignature === undefined);
		if (liveUnsignedText?.type !== "text") throw new Error("Expected the unsigned text block");
		expect(liveUnsignedText.text.length).toBe(MAX_PERSIST_CHARS);
		expect(liveUnsignedText.text.endsWith(TRUNCATION_NOTICE)).toBe(true);
		expect(liveUnsignedText.text.startsWith(turn.body.slice(0, 1000))).toBe(true);

		// (2) Signed and encrypted blocks survive verbatim in memory: truncating
		// them would invalidate the signature and the provider rejects the replay.
		const liveThinking = live.find(block => block.type === "thinking");
		if (liveThinking?.type !== "thinking") throw new Error("Expected the thinking block");
		expect(liveThinking.thinking).toBe(turn.thinking);
		expect(liveThinking.thinkingSignature).toBe(turn.thinkingSignature);

		const liveSignedText = live.find(block => block.type === "text" && block.textSignature !== undefined);
		if (liveSignedText?.type !== "text") throw new Error("Expected the signed text block");
		expect(liveSignedText.text).toBe(turn.signedText);
		expect(liveSignedText.textSignature).toBe(turn.textSignature);

		const liveRedacted = live.find(block => block.type === "redactedThinking");
		if (liveRedacted?.type !== "redactedThinking") throw new Error("Expected the redacted thinking block");
		expect(liveRedacted.data).toBe(turn.redacted);

		// (3) Round-trip: the reloaded entry matches the live one exactly, and the
		// truncation notice is applied once — never stacked by the persist pass.
		manager.flushSync();
		await manager.close();

		const reloaded = await loadEntriesFromFile(sessionFile);
		const disk = assistantContent(reloaded.at(-1) as SessionMessageEntry);
		expect(disk).toEqual(live);

		const diskUnsignedText = disk.find(block => block.type === "text" && block.textSignature === undefined);
		if (diskUnsignedText?.type !== "text") throw new Error("Expected the unsigned text block on disk");
		expect(diskUnsignedText.text.length).toBe(MAX_PERSIST_CHARS);
		expect(diskUnsignedText.text.split(TRUNCATION_NOTICE)).toHaveLength(2);
	});

	it("recomputes lineCount when a truncated tool detail is capped in memory", () => {
		const cwd = makeTempDir("@pi-mem-linecount-cwd-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));

		const content = `${"line\n".repeat(200_000)}tail`;
		expect(content.length).toBeGreaterThan(MAX_PERSIST_CHARS);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			details: { content, lineCount: 200_001 },
			isError: false,
			timestamp: Date.now(),
		});

		const entry = manager.getEntries().at(-1) as SessionMessageEntry;
		if (entry.message.role !== "toolResult") throw new Error("Expected a toolResult entry");
		const details = entry.message.details as { content: string; lineCount: number };
		expect(details.content.length).toBe(MAX_PERSIST_CHARS);
		expect(details.lineCount).toBe(details.content.split("\n").length);
		expect(details.lineCount).toBeLessThan(200_001);
	});
});
