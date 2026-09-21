/**
 * Regression: a `[Image #N]` marker relayed to a text-only model, a compacted
 * transcript, or a sub-agent (which never inherits `pendingImages`) reached
 * the model as a plain filesystem-looking token with no image behind it —
 * the model then hallucinated a file search instead of asking for the image
 * (production, 2026-09-21). `annotateOutgoingImageMarkers` rewrites the
 * outgoing text so every marker is either self-describing or explicitly
 * flagged as never-arrived.
 */
import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { annotateOutgoingImageMarkers } from "@oh-my-pi/pi-coding-agent/modes/image-references";
import { parseImageAttachmentReference } from "@oh-my-pi/pi-coding-agent/tools/inspect-image";

function image(byte: number): ImageContent {
	return { type: "image", data: Buffer.from([byte]).toString("base64"), mimeType: "image/png" };
}

/** Mirrors `AgentSession.getImageAttachments()` (agent-session.ts): `attachment://N`
 *  is 1-based position within the outgoing message's image content parts, which is
 *  exactly the `images` array passed to `session.prompt()` — `normalizeModelContextImages`
 *  maps it 1:1 with no reordering/dropping. Used here to prove the annotated
 *  reference resolves, not just that it looks right. */
function attachmentsFor(images: readonly ImageContent[]) {
	return images.map((img, index) => ({ label: `Image #${index + 1}`, uri: `attachment://${index + 1}`, image: img }));
}

describe("annotateOutgoingImageMarkers", () => {
	it("rewrites an orphan marker to the not-delivered note when no images are pending", () => {
		const out = annotateOutgoingImageMarkers("look at [Image #1, 512x872] please", undefined);
		expect(out).toBe(
			"look at [Image #1 referenced but its image data never arrived in this session — ask the user to re-paste it into the loom prompt directly, or save it to a file and give you the path] please",
		);
	});

	it("annotates a resolvable marker with attachment://N and the reference round-trips through inspect_image's own resolver", () => {
		const images = [image(1)];
		const out = annotateOutgoingImageMarkers("look at [Image #1, 512x872]", images);
		expect(out).toBe("look at [Image #1, 512x872, attachment://1]");

		const uri = /attachment:\/\/\d+/.exec(out)?.[0];
		expect(uri).toBeDefined();
		const reference = parseImageAttachmentReference(uri!);
		expect(reference).not.toBeNull();
		const attachments = attachmentsFor(images);
		expect(attachments[reference!.index - 1]?.image).toBe(images[0]);
	});

	it("treats a real marker and an orphan marker independently in the same text", () => {
		const images = [image(7)];
		const out = annotateOutgoingImageMarkers("first [Image #1] then [Image #2, 10x10] end", images);
		expect(out).toBe(
			"first [Image #1, attachment://1] then " +
				"[Image #2 referenced but its image data never arrived in this session — ask the user to re-paste it into the loom prompt directly, or save it to a file and give you the path] end",
		);
	});

	it("leaves text with no Image markers untouched", () => {
		expect(annotateOutgoingImageMarkers("no markers here", [image(1)])).toBe("no markers here");
	});
});
