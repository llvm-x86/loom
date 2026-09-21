import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type BlobPutResult, blobExtensionForImageMimeType } from "../session/blob-store";
import { fileHyperlink } from "../tui/hyperlink";

/** Matches `[Image #N]`/`[Image #N, WxH]` and `[Paste #N, +X lines]`/`[Paste #N, Y chars]` tokens.
 *  Group 1 is the kind (`Image`/`Paste`), group 2 the 1-based index. The optional metadata
 *  tail (`, …`) is captured loosely (no `]`/newline) so future label tweaks keep matching. */
export const PLACEHOLDER_REGEX = /\[(Image|Paste) #([1-9]\d*)(?:,[^\]\n]*)?\]/g;

/** Matches a single `[Image #N]` / `[Image #N, WxH]` marker. Group 1 is the
 *  1-based index, group 2 the optional metadata tail (leading comma, no `]` or
 *  newline) so future label tweaks keep matching. Paste markers are excluded
 *  on purpose: their numbering is owned by the editor's paste store, not by
 *  the pending-image buffer. */
const IMAGE_MARKER_REGEX = /\[Image #([1-9]\d*)((?:,[^\]\n]*)?)\]/g;

/** Renumber every `[Image #N]` marker in `text` by `offset` (added to the
 *  existing index), preserving the optional `, WxH` tail. Paste markers are
 *  left untouched. Used when restoring queued image-messages back into a draft
 *  that already holds pending images so the merged text's positional markers
 *  still line up with `pendingImages`. */
export function shiftImageMarkers(text: string, offset: number): string {
	if (offset === 0) return text;
	return text.replace(
		IMAGE_MARKER_REGEX,
		(_match, idx: string, tail: string) => `[Image #${Number(idx) + offset}${tail}]`,
	);
}

/** Note substituted for an `[Image #N]` marker whose index has no backing
 *  `pendingImages` entry. Observed in production 2026-09-21: a relayed/
 *  compacted/sub-agent-delegated marker with no image behind it reads to the
 *  model as a plain filesystem path, and the model hallucinates a search for
 *  it instead of asking the user to re-supply the image. */
function orphanImageMarkerNote(index: number): string {
	return `[Image #${index} referenced but its image data never arrived in this session — ask the user to re-paste it into the loom prompt directly, or save it to a file and give you the path]`;
}

/** Rewrite every `[Image #N]` marker in outgoing `text` so it survives relay,
 *  compaction, and sub-agent delegation (none of which carry `pendingImages`
 *  along with the text):
 *  - N with no matching `pendingImages` entry becomes {@link orphanImageMarkerNote}.
 *  - N that resolves gets its `attachment://N` reference appended. This N is
 *    the SAME 1-based index the marker already carries — verified against
 *    `AgentSession.getImageAttachments()` (agent-session.ts), which numbers
 *    `attachment://N` by position within the outgoing message's image content
 *    parts, and `normalizeModelContextImages` (image-loading.ts), which maps
 *    `images` to that content 1:1 with no reordering/dropping — so marker N
 *    and attachment N are the same slot by construction, not by luck.
 *  Only applied to the text actually sent; draft positional semantics
 *  (`[Image #N]` ↔ `pendingImages[N-1]`) are untouched. */
export function annotateOutgoingImageMarkers(text: string, pendingImages: readonly ImageContent[] | undefined): string {
	const count = pendingImages?.length ?? 0;
	return text.replace(IMAGE_MARKER_REGEX, (_match, idx: string, tail: string) => {
		const index = Number(idx);
		if (index > count) return orphanImageMarkerNote(index);
		return `[Image #${idx}${tail}, attachment://${index}]`;
	});
}

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<BlobPutResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => BlobPutResult;

export type PlaceholderKind = "image" | "paste";

export interface PlaceholderRenderers {
	renderText: (text: string) => string;
	renderReference: (label: string, kind: PlaceholderKind, index: number) => string;
}

export function renderPlaceholders(text: string, renderers: PlaceholderRenderers): string {
	PLACEHOLDER_REGEX.lastIndex = 0;
	let result = "";
	let last = 0;
	let matched = false;

	for (;;) {
		const match = PLACEHOLDER_REGEX.exec(text);
		if (match === null) break;
		matched = true;
		if (match.index > last) {
			result += renderers.renderText(text.slice(last, match.index));
		}
		const kind: PlaceholderKind = match[1] === "Paste" ? "paste" : "image";
		result += renderers.renderReference(match[0], kind, Number(match[2]));
		last = match.index + match[0].length;
	}

	if (!matched) {
		return renderers.renderText(text);
	}
	if (last < text.length) {
		result += renderers.renderText(text.slice(last));
	}
	return result;
}

export function imageReferenceHyperlink(
	label: string,
	index: number,
	imageLinks: readonly (string | undefined)[] | undefined,
	renderLabel: (text: string) => string,
): string {
	const rendered = renderLabel(label);
	const target = imageLinks?.[index - 1];
	return target ? fileHyperlink(target, rendered) : rendered;
}

async function materializeImageReferenceLinkAsync(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriter,
): Promise<string | undefined> {
	try {
		const result = await putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function materializeImageReferenceLink(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriterSync,
): string | undefined {
	try {
		const result = putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function materializeImageReferenceLinks(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriter,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob));
	return links.some(link => link !== undefined) ? links : undefined;
}
