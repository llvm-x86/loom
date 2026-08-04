/**
 * Regression: `tools.outputMaxColumns` meant two different things.
 *
 * The streaming sink measured UTF-8 bytes and charged the 3-byte `…` against
 * the cap (a stated 768 kept 765 data bytes); `read` spent the same number on
 * UTF-16 code units and appended the marker on top. A line of U+00E9 kept 1536
 * bytes through `read` and 764 through bash — and both printed the identical
 * notice `Some lines truncated to 768 chars`, which was true of neither.
 *
 * These tests pin: (1) one unit — the same wide multibyte line keeps the same
 * number of BYTES on both surfaces; (2) a notice that names the unit and the
 * surviving width; (3) the `:raw` recovery hint on `read` (where it works) and
 * its absence on the streaming path (where the artifact is the recovery).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { formatOutputNotice, outputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import { ReadTool, truncateLineToBytes } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const COLUMN_CAP = 768;

/** Latin small e with acute: 1 UTF-16 code unit, 2 UTF-8 bytes. */
const TWO_BYTE = "\u00e9";
/** Grinning face: 2 UTF-16 code units, 4 UTF-8 bytes. */
const FOUR_BYTE = "\u{1f600}";

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	settings.set("tools.outputMaxColumns", COLUMN_CAP);
	settings.set("read.summarize.enabled", false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
		enableLsp: false,
	};
}

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

/**
 * Pull the surviving run of `char` that the `…` marker terminates, out of an
 * output that also carries hashline headers, line numbers and notices.
 */
function keptRun(output: string, char: string): string {
	const match = new RegExp(`((?:${char})+)…`, "u").exec(output);
	if (!match) throw new Error(`no truncated run of ${JSON.stringify(char)} in:\n${output.slice(0, 400)}`);
	return match[1]!;
}

async function sinkKeptBytes(line: string, char: string): Promise<number> {
	const sink = new OutputSink({ maxColumns: COLUMN_CAP, spillThreshold: 10_000_000 });
	await sink.push(`${line}\n`);
	const dumped = await sink.dump();
	return Buffer.byteLength(keptRun(dumped.output, char), "utf-8");
}

describe("tools.outputMaxColumns is one unit across read and the streaming sink", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "column-cap-units-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	async function readKeptBytes(char: string, line: string): Promise<number> {
		const filePath = path.join(tmpDir, `wide-${char.codePointAt(0)}.txt`);
		await fs.writeFile(filePath, `${line}\n`);
		const result = await new ReadTool(createSession(tmpDir)).execute("call-wide", { path: filePath });
		return Buffer.byteLength(keptRun(textOutput(result), char), "utf-8");
	}

	it.each([
		["2-byte U+00E9", TWO_BYTE],
		["4-byte U+1F600", FOUR_BYTE],
	])("keeps the same bytes on both surfaces for a wide %s line", async (_label, char) => {
		const line = char.repeat(2000);
		const viaRead = await readKeptBytes(char, line);
		const viaSink = await sinkKeptBytes(line, char);

		expect(viaRead).toBe(viaSink);
		// The marker is charged against the cap, and a multibyte character is
		// never split, so the kept data is the largest whole-character run that
		// fits in `cap - 3`.
		const charBytes = Buffer.byteLength(char, "utf-8");
		expect(viaRead).toBe(Math.floor((COLUMN_CAP - 3) / charBytes) * charBytes);
		expect(viaRead + 3).toBeLessThanOrEqual(COLUMN_CAP);
	});

	it("never splits a multibyte character", () => {
		// 767 bytes of budget for 2-byte chars leaves one byte unusable.
		const { text, wasTruncated } = truncateLineToBytes(TWO_BYTE.repeat(1000), 770);
		expect(wasTruncated).toBe(true);
		expect(text.endsWith("…")).toBe(true);
		expect(text).not.toContain("\ufffd");
		expect(Buffer.byteLength(text, "utf-8")).toBe(766 + 3);
	});

	it("leaves a line that fits untouched", () => {
		const line = TWO_BYTE.repeat(384); // exactly 768 bytes
		expect(truncateLineToBytes(line, COLUMN_CAP)).toEqual({ text: line, wasTruncated: false });
		expect(truncateLineToBytes(`${line}${TWO_BYTE}`, COLUMN_CAP).wasTruncated).toBe(true);
	});
});

describe("column-cap notice states the unit, the surviving width, and the recovery", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "column-cap-notice-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("points `read` at :raw, which bypasses the cap", async () => {
		const filePath = path.join(tmpDir, "wide.txt");
		await fs.writeFile(filePath, `${"x".repeat(3000)}\n`);
		const session = createSession(tmpDir);
		const result = await new ReadTool(session).execute("call-notice", { path: filePath });

		const notice = formatOutputNotice(result.details?.meta);
		expect(notice).toContain("Some lines truncated to 765 of 768 bytes");
		expect(notice).toContain("re-read with :raw for full lines");
		expect(notice).not.toContain("artifact://");

		// The hint is honest: `:raw` really does return the full line.
		const raw = await new ReadTool(session).execute("call-raw", { path: `${filePath}:raw` });
		expect(textOutput(raw)).toContain("x".repeat(3000));
	});

	it("points the streaming path at its artifact, never at :raw", async () => {
		const sink = new OutputSink({ maxColumns: 768, spillThreshold: 100_000 });
		await sink.push(`${"x".repeat(3000)}\n`);
		const dumped = await sink.dump();

		const notice = formatOutputNotice(outputMeta().truncationFromSummary(dumped, { direction: "tail" }).get());
		expect(notice).toContain("Some lines truncated to 765 of 768 bytes");
		expect(notice).not.toContain(":raw");
	});

	it("keeps grep's char cap reported in chars", () => {
		// grep's `truncateLine` cap counts UTF-16 code units and appends the
		// marker on top; reporting it as bytes would be the same lie in reverse.
		const notice = formatOutputNotice(outputMeta().columnTruncated(512, { unit: "chars" }).get());
		expect(notice).toContain("Some lines truncated to 512 chars");
		expect(notice).not.toContain("bytes");
	});
});
