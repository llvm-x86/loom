import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";

/**
 * Prebuilt native-addon fetcher.
 *
 * `scripts/build-native.ts` compiles `crates/pi-natives` with a local Rust
 * toolchain. On machines without cargo — most notably a fresh Windows dev box
 * where the checked-in tree ships no `pi_natives.win32-x64*.node` — that build
 * fails deep inside the napi CLI with the opaque `cargo metadata failed to
 * run`. Every supported platform's addon is also published on npm as an
 * optional-dependency leaf package `@oh-my-pi/pi-natives-<platform>-<arch>` at
 * the lockstep version, so instead of forcing a from-source build we can
 * download the already-built `.node` for the current tag.
 *
 * This module downloads the leaf tarball for the EXACT local package version
 * (so the addon's `__piNativesV<version>` sentinel matches the loader), verifies
 * its npm `dist.integrity` sha512, and extracts the `*.node` payload into
 * `native/`, where `loader-state.js` already probes for it.
 */

const REGISTRY = process.env.PI_NATIVES_REGISTRY?.replace(/\/+$/, "") || "https://registry.npmjs.org";

interface NpmDist {
	tarball: string;
	integrity?: string;
	shasum?: string;
}

interface NpmVersionManifest {
	dist: NpmDist;
}

export interface FetchPrebuiltInput {
	platform: string;
	arch: string;
	version: string;
	nativeDir: string;
	/** Overwrite existing `.node` files even if already present. */
	force?: boolean;
}

export interface FetchPrebuiltResult {
	packageName: string;
	version: string;
	written: string[];
}

function leafPackageName(platform: string, arch: string): string {
	return `@oh-my-pi/pi-natives-${platform}-${arch}`;
}

/** npm scoped-package metadata URL, exact version. `@scope/name` → `@scope%2fname`. */
function versionManifestUrl(pkg: string, version: string): string {
	const encoded = pkg.replace("/", "%2f");
	return `${REGISTRY}/${encoded}/${version}`;
}

/** Verify `buffer` against an npm Subresource-Integrity string (`sha512-<base64>`). */
function verifyIntegrity(buffer: Buffer, integrity: string | undefined): void {
	if (!integrity) return;
	// npm may list multiple space-separated hashes; a single match is sufficient.
	for (const entry of integrity.split(/\s+/).filter(Boolean)) {
		const [algorithm, expected] = entry.split("-", 2);
		if (!algorithm || !expected) continue;
		if (!["sha512", "sha384", "sha256", "sha1"].includes(algorithm)) continue;
		const actual = crypto.createHash(algorithm).update(buffer).digest("base64");
		if (actual === expected) return;
		throw new Error(
			`Integrity check failed for prebuilt native tarball (${algorithm}):\n  expected ${expected}\n  actual   ${actual}`,
		);
	}
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
	const end = Math.min(offset + length, buffer.length);
	let stringEnd = offset;
	while (stringEnd < end && buffer[stringEnd] !== 0) stringEnd++;
	return buffer.toString("utf8", offset, stringEnd);
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number {
	const value = readTarString(buffer, offset, length).trim();
	if (!value) return 0;
	const parsed = Number.parseInt(value, 8);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid tar octal value: ${value}`);
	return parsed;
}

function isZeroTarBlock(buffer: Buffer, offset: number): boolean {
	for (let index = 0; index < 512 && offset + index < buffer.length; index++) {
		if (buffer[offset + index] !== 0) return false;
	}
	return true;
}

/** Extract `*.node` entries from an in-memory gzipped npm tarball into `targetDir`. */
async function extractNodeAddons(tarball: Buffer, targetDir: string): Promise<string[]> {
	const archive = zlib.gunzipSync(tarball);
	const written: string[] = [];
	let offset = 0;

	while (offset + 512 <= archive.length) {
		if (isZeroTarBlock(archive, offset)) break;
		const name = readTarString(archive, offset, 100);
		const prefix = readTarString(archive, offset + 345, 155);
		const fullName = prefix ? `${prefix}/${name}` : name;
		const size = readTarOctal(archive, offset + 124, 12);
		const typeflag = archive[offset + 156] === 0 ? "0" : String.fromCharCode(archive[offset + 156]);
		offset += 512;

		if (offset + size > archive.length) throw new Error(`Truncated tarball entry: ${fullName}`);

		if (typeflag === "0" && fullName.endsWith(".node")) {
			const basename = path.basename(fullName);
			const targetPath = path.join(targetDir, basename);
			await fs.writeFile(targetPath, archive.subarray(offset, offset + size));
			written.push(targetPath);
		}

		offset += Math.ceil(size / 512) * 512;
	}

	return written;
}

/**
 * Download and install the prebuilt `.node` for `platform`/`arch`/`version`.
 * Throws with an actionable message when the leaf package or version is
 * missing (e.g. an unreleased local version has no published prebuilt).
 */
export async function fetchPrebuiltNative({
	platform,
	arch,
	version,
	nativeDir,
	force = false,
}: FetchPrebuiltInput): Promise<FetchPrebuiltResult> {
	const pkg = leafPackageName(platform, arch);
	const manifestUrl = versionManifestUrl(pkg, version);

	const manifestResponse = await fetch(manifestUrl);
	if (manifestResponse.status === 404) {
		throw new Error(
			`No prebuilt native published for ${pkg}@${version}.\n` +
				`(npm has no such package/version — an unreleased local version has no prebuilt.)`,
		);
	}
	if (!manifestResponse.ok) {
		throw new Error(`Failed to query ${manifestUrl}: HTTP ${manifestResponse.status} ${manifestResponse.statusText}`);
	}
	const manifest = (await manifestResponse.json()) as NpmVersionManifest;
	const { tarball, integrity } = manifest.dist;

	const tarballResponse = await fetch(tarball);
	if (!tarballResponse.ok) {
		throw new Error(`Failed to download ${tarball}: HTTP ${tarballResponse.status} ${tarballResponse.statusText}`);
	}
	const tarballBuffer = Buffer.from(await tarballResponse.arrayBuffer());
	verifyIntegrity(tarballBuffer, integrity);

	await fs.mkdir(nativeDir, { recursive: true });

	if (!force) {
		// Skip the download-extract if a matching `.node` is already staged.
		const existing = await fs.readdir(nativeDir).catch(() => [] as string[]);
		const alreadyPresent = existing.filter(
			name => name.startsWith(`pi_natives.${platform}-${arch}`) && name.endsWith(".node"),
		);
		if (alreadyPresent.length > 0) {
			return { packageName: pkg, version, written: alreadyPresent.map(name => path.join(nativeDir, name)) };
		}
	}

	const written = await extractNodeAddons(tarballBuffer, nativeDir);
	if (written.length === 0) {
		throw new Error(`Prebuilt tarball ${tarball} contained no .node addon`);
	}
	return { packageName: pkg, version, written };
}

if (import.meta.main) {
	const nativeDir = path.join(import.meta.dir, "../native");
	const packageJsonPath = path.join(import.meta.dir, "../package.json");
	const { version } = (await Bun.file(packageJsonPath).json()) as { version: string };
	const platform = Bun.env.TARGET_PLATFORM || process.platform;
	const arch = Bun.env.TARGET_ARCH || process.arch;
	const force = process.argv.includes("--force");

	console.log(`Fetching prebuilt pi-natives ${platform}-${arch}@${version} from ${REGISTRY}…`);
	const result = await fetchPrebuiltNative({ platform, arch, version, nativeDir, force });
	console.log(`Installed prebuilt from ${result.packageName}@${result.version}:`);
	for (const file of result.written) console.log(`  ${file}`);
}
