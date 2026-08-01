import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { BlobStore, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { FileEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	installLazyBlobRefsInEntries,
	resolveBlobRefsInEntries,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { prepareEntryForPersistence } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { TempDir } from "@oh-my-pi/pi-utils";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolResultEntry = Omit<SessionMessageEntry, "message"> & { message: ToolResultMessage };

function imageEntry(id: string, data: string): ToolResultEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "read",
			content: [{ type: "image", data, mimeType: "image/png" }],
			details: { image_url: `data:image/png;base64,${data}` },
			isError: false,
			timestamp: 0,
		} as unknown as ToolResultMessage,
	};
}

function contentImage(entry: FileEntry | undefined): ImageContent {
	const message = (entry as ToolResultEntry | undefined)?.message;
	const block = message?.content.find((candidate): candidate is ImageContent => candidate.type === "image");
	if (!block) throw new Error("Expected an image block");
	return block;
}

describe("lazy blob rehydration", () => {
	it("resolves each image identically to the eager pass, but only on first access", async () => {
		using tempDir = TempDir.createSync("@session-lazy-blob-");
		const blobStore = new BlobStore(tempDir.path());

		const touched = "t".repeat(4096);
		const untouched = "u".repeat(4096);
		const touchedData = Buffer.from(touched).toString("base64");
		const untouchedData = Buffer.from(untouched).toString("base64");

		const persisted = [
			prepareEntryForPersistence(imageEntry("touched", touchedData), blobStore),
			prepareEntryForPersistence(imageEntry("untouched", untouchedData), blobStore),
		];
		expect(isBlobRef(contentImage(persisted[0]).data)).toBe(true);

		// Reference: what the eager pass produces.
		const eager: FileEntry[] = persisted.map(entry => structuredClone(entry));
		await resolveBlobRefsInEntries(eager, blobStore);

		let reads = 0;
		const origGetSync = blobStore.getSync.bind(blobStore);
		blobStore.getSync = (hash: string) => {
			reads++;
			return origGetSync(hash);
		};

		const lazy: FileEntry[] = persisted.map(entry => structuredClone(entry));
		installLazyBlobRefsInEntries(lazy, blobStore);

		// Arming costs nothing: no blob has been read yet.
		expect(reads).toBe(0);

		// First access resolves byte-identically to the eager pass...
		expect(contentImage(lazy[0]).data).toBe(touchedData);
		expect(contentImage(lazy[0]).data).toBe(contentImage(eager[0]).data);
		const afterFirst = reads;
		expect(afterFirst).toBeGreaterThan(0);

		// ...and collapses to a plain value, so re-reads never touch the store again.
		expect(contentImage(lazy[0]).data).toBe(touchedData);
		expect(reads).toBe(afterFirst);

		// The untouched entry has still never been materialized.
		expect(Object.getOwnPropertyDescriptor(contentImage(lazy[1]), "data")?.value).toBeUndefined();

		// Provider `image_url` data URLs restore to the original string too.
		const lazyDetails = (lazy[1] as ToolResultEntry).message.details as { image_url: string };
		const eagerDetails = (eager[1] as ToolResultEntry).message.details as { image_url: string };
		expect(lazyDetails.image_url).toBe(eagerDetails.image_url);
		expect(lazyDetails.image_url).toBe(`data:image/png;base64,${untouchedData}`);

		// Whole-entry equality after materialization: lazy and eager agree exactly.
		expect(JSON.parse(JSON.stringify(lazy))).toEqual(JSON.parse(JSON.stringify(eager)));
	});

	it("degrades to the ref string when the blob disappeared, matching the eager pass", async () => {
		using tempDir = TempDir.createSync("@session-lazy-blob-missing-");
		const blobStore = new BlobStore(tempDir.path());
		const data = Buffer.from("g".repeat(4096)).toString("base64");
		const persisted = prepareEntryForPersistence(imageEntry("gone", data), blobStore);
		const ref = contentImage(persisted).data;
		expect(isBlobRef(ref)).toBe(true);

		const lazy: FileEntry[] = [structuredClone(persisted)];
		installLazyBlobRefsInEntries(lazy, blobStore);
		await Bun.file(`${tempDir.path()}/${ref.slice("blob:sha256:".length)}`).unlink();

		expect(contentImage(lazy[0]).data).toBe(ref);
	});
});
