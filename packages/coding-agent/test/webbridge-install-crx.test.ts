import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	computeExtensionId,
	ensureSigningKey,
	packCrx,
	writeCrxArtifacts,
} from "@oh-my-pi/pi-coding-agent/webbridge/install/crx";

/**
 * Locks the correctness-critical CRX crux: the extension id is derived from the
 * signing key exactly as Chromium does it (first 16 bytes of SHA-256(SPKI DER),
 * hex mapped a-p), the packed container is a valid CRX3 wrapping a real ZIP, and
 * the emitted update.xml points at the crx via a file:// codebase. The id is the
 * same value that force-install matches against, so determinism is load-bearing.
 */
describe("WebBridge CRX packer", () => {
	let tmp: string;
	let extDir: string;
	let outDir: string;
	let keyPath: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wb-crx-"));
		extDir = path.join(tmp, "ext");
		outDir = path.join(tmp, "out");
		keyPath = path.join(tmp, "key.pem");
		await fs.mkdir(extDir, { recursive: true });
		await fs.writeFile(
			path.join(extDir, "manifest.json"),
			JSON.stringify({ manifest_version: 3, name: "Test", version: "2.4.0" }),
		);
		await fs.writeFile(path.join(extDir, "background.js"), "// noop\n");
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("derives the extension id like Chromium (16-byte SHA-256 prefix, a-p)", () => {
		const der = Buffer.from("some-fake-spki-der-bytes");
		const id = computeExtensionId(der);
		expect(id).toHaveLength(32);
		expect(id).toMatch(/^[a-p]{32}$/);

		// Reproduce the algorithm independently to prove the mapping.
		const digest = createHash("sha256").update(der).digest();
		let expected = "";
		for (let i = 0; i < 16; i += 1) {
			const byte = digest[i];
			expected += String.fromCharCode(97 + (byte >> 4));
			expected += String.fromCharCode(97 + (byte & 0x0f));
		}
		expect(id).toBe(expected);
	});

	it("produces a stable id + public key for a persisted signing key", async () => {
		const first = await ensureSigningKey(keyPath);
		const second = await ensureSigningKey(keyPath);
		expect(second.extensionId).toBe(first.extensionId);
		expect(second.publicKeyDerBase64).toBe(first.publicKeyDerBase64);
		expect(first.extensionId).toMatch(/^[a-p]{32}$/);
	});

	it("packs a valid CRX3 container wrapping a ZIP", async () => {
		const key = await ensureSigningKey(keyPath);
		const crx = await packCrx(extDir, key.privateKeyPem);
		// CRX3 magic "Cr24" + little-endian version 3.
		expect(crx.subarray(0, 4).toString("latin1")).toBe("Cr24");
		expect(crx.readUInt32LE(4)).toBe(3);
		// The ZIP payload's local-file-header signature "PK\x03\x04" appears after the header.
		expect(crx.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
	});

	it("writes crx + update.xml with a file:// codebase and matching appid", async () => {
		const artifacts = await writeCrxArtifacts({ extDir, outDir, keyPath });
		expect(artifacts.extensionId).toMatch(/^[a-p]{32}$/);

		const crx = await fs.readFile(artifacts.crxPath);
		expect(crx.subarray(0, 4).toString("latin1")).toBe("Cr24");

		const xml = await fs.readFile(artifacts.updateManifestPath, "utf8");
		expect(xml).toContain(`appid="${artifacts.extensionId}"`);
		expect(xml).toContain('version="2.4.0"');
		expect(xml).toContain(`codebase="file://`);
		expect(xml).toContain(artifacts.crxPath.split(path.sep).join("/"));
	});
});
