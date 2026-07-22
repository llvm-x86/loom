/**
 * CRX3 packer + signing key + deterministic extension id.
 *
 * Force-installing off the Web Store requires a signed CRX served from a local
 * `update.xml`. We pack the unpacked extension into a ZIP (zero-dependency,
 * via node:zlib), wrap it in the CRX3 container, and RSA-sign it. The extension
 * id is derived from the signing key exactly as Chromium does, so it is stable
 * across machines and matches an unpacked load that carries the same `"key"`.
 *
 * CRX3 layout: "Cr24" | u32le(version=3) | u32le(headerLen) | header | zip.
 * The signature covers: "CRX3 SignedData\0" | u32le(signedHeaderLen) |
 * signedHeaderData | zipBytes  (see Chromium crx_verifier.cc).
 */
import { createHash, createPublicKey, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";
import type { CrxArtifacts } from "./types";

// ---------------------------------------------------------------------------
// Signing key
// ---------------------------------------------------------------------------

export interface SigningKey {
	privateKeyPem: string;
	/** DER SubjectPublicKeyInfo, base64 (the manifest `"key"` value). */
	publicKeyDerBase64: string;
	extensionId: string;
}

/** Load the RSA signing key at `keyPath`, generating + persisting one if absent. */
export async function ensureSigningKey(keyPath: string): Promise<SigningKey> {
	let privateKeyPem: string;
	try {
		privateKeyPem = await fs.readFile(keyPath, "utf8");
	} catch {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		await fs.mkdir(path.dirname(keyPath), { recursive: true });
		await fs.writeFile(keyPath, privateKeyPem, { mode: 0o600 });
	}
	const publicKey = createPublicKey(privateKeyPem);
	return keyToIdentity(privateKeyPem, publicKey);
}

function keyToIdentity(privateKeyPem: string, publicKey: KeyObject): SigningKey {
	const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
	return {
		privateKeyPem,
		publicKeyDerBase64: publicKeyDer.toString("base64"),
		extensionId: computeExtensionId(publicKeyDer),
	};
}

/**
 * Chromium's extension id: first 16 bytes of SHA-256(publicKeyDer), rendered as
 * hex, then each hex digit `0-f` mapped to `a-p`.
 */
export function computeExtensionId(publicKeyDer: Buffer): string {
	const digest = createHash("sha256").update(publicKeyDer).digest();
	let id = "";
	for (let i = 0; i < 16; i += 1) {
		const byte = digest[i];
		id += String.fromCharCode(97 + (byte >> 4));
		id += String.fromCharCode(97 + (byte & 0x0f));
	}
	return id;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (deflate) — deterministic, dependency-free
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
	name: string;
	data: Buffer;
}

/** Recursively collect files under `dir` as POSIX-relative zip entries. */
async function collectFiles(dir: string, base = dir): Promise<ZipEntry[]> {
	const entries: ZipEntry[] = [];
	for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
		const abs = path.join(dir, dirent.name);
		if (dirent.isDirectory()) {
			entries.push(...(await collectFiles(abs, base)));
		} else if (dirent.isFile()) {
			const rel = path.relative(base, abs).split(path.sep).join("/");
			entries.push({ name: rel, data: await fs.readFile(abs) });
		}
	}
	return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function buildZip(entries: ZipEntry[]): Buffer {
	const DOS_DATE = 0x0021; // 1980-01-01, fixed for determinism
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const crc = crc32(entry.data);
		const compressed = deflateRawSync(entry.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBuf, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(entry.data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBuf);

		offset += local.length + nameBuf.length + compressed.length;
	}
	const localBuf = Buffer.concat(locals);
	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(localBuf.length, 16);
	eocd.writeUInt16LE(0, 20);
	return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Protobuf + CRX3 container
// ---------------------------------------------------------------------------

function varint(value: number): Buffer {
	const bytes: number[] = [];
	let v = value;
	do {
		let byte = v & 0x7f;
		v >>>= 7;
		if (v > 0) byte |= 0x80;
		bytes.push(byte);
	} while (v > 0);
	return Buffer.from(bytes);
}

/** Encode one length-delimited protobuf field (wire type 2). */
function lenField(fieldNumber: number, payload: Buffer): Buffer {
	const tag = varint((fieldNumber << 3) | 2);
	return Buffer.concat([tag, varint(payload.length), payload]);
}

const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\0", "latin1");

/** Pack the extension at `extDir` into a signed CRX3 buffer. */
export async function packCrx(extDir: string, privateKeyPem: string): Promise<Buffer> {
	const zip = buildZip(await collectFiles(extDir));
	const publicKey = createPublicKey(privateKeyPem);
	const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
	const crxId = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);

	// SignedData { crx_id = field 1 }
	const signedHeaderData = lenField(1, crxId);

	// Signature input: context | u32le(signedHeaderLen) | signedHeaderData | zip
	const sizeLe = Buffer.alloc(4);
	sizeLe.writeUInt32LE(signedHeaderData.length, 0);
	const signer = createSign("sha256");
	signer.update(SIGNATURE_CONTEXT);
	signer.update(sizeLe);
	signer.update(signedHeaderData);
	signer.update(zip);
	const signature = signer.sign(privateKeyPem);

	// AsymmetricKeyProof { public_key = 1, signature = 2 }
	const proof = Buffer.concat([lenField(1, publicKeyDer), lenField(2, signature)]);
	// CrxFileHeader { sha256_with_rsa = 2 (repeated), signed_header_data = 10000 }
	const header = Buffer.concat([lenField(2, proof), lenField(10000, signedHeaderData)]);

	const prefix = Buffer.alloc(12);
	prefix.write("Cr24", 0, "latin1");
	prefix.writeUInt32LE(3, 4);
	prefix.writeUInt32LE(header.length, 8);
	return Buffer.concat([prefix, header, zip]);
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

async function readManifestVersion(extDir: string): Promise<string> {
	try {
		const raw = await fs.readFile(path.join(extDir, "manifest.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") {
			return parsed.version;
		}
	} catch {}
	return "1.0.0";
}

function updateManifestXml(extensionId: string, crxPath: string, version: string): string {
	const codebase = pathToFileURL(crxPath).href;
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
		`  <app appid="${extensionId}">`,
		`    <updatecheck codebase="${codebase}" version="${version}" />`,
		"  </app>",
		"</gupdate>",
		"",
	].join("\n");
}

/**
 * Pack `extDir` and emit the CRX + `update.xml` into `outDir`, using (and
 * creating) the signing key at `keyPath`. Returns the paths + extension id.
 */
export async function writeCrxArtifacts(opts: {
	extDir: string;
	outDir: string;
	keyPath: string;
	crxName?: string;
}): Promise<CrxArtifacts> {
	const key = await ensureSigningKey(opts.keyPath);
	const crx = await packCrx(opts.extDir, key.privateKeyPem);
	await fs.mkdir(opts.outDir, { recursive: true });
	const crxPath = path.join(opts.outDir, opts.crxName ?? "loom-webbridge.crx");
	await fs.writeFile(crxPath, crx);
	const version = await readManifestVersion(opts.extDir);
	const updateManifestPath = path.join(opts.outDir, "update.xml");
	await fs.writeFile(updateManifestPath, updateManifestXml(key.extensionId, crxPath, version), "utf8");
	return {
		crxPath,
		updateManifestPath,
		extensionId: key.extensionId,
		publicKeyBase64: key.publicKeyDerBase64,
	};
}
