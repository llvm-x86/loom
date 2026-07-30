import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

/** Inputs shared by local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Concrete Transformers.js version baked into the tiny-model worker. */
	readonly transformersVersion: string;
	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Match release builds that minify identifiers while retaining names. */
	readonly minifyIdentifiers?: boolean;
	/** Disable Bun's built-in Darwin signing before the caller re-signs. */
	readonly skipBuiltinCodesign?: boolean;
}

/**
 * On Windows an existing executable may be locked (e.g. a running loom process
 * or a defender scan). Rename it out of the way so Bun.build can write the new
 * file, then best-effort delete the old copy. Renaming a running executable is
 * allowed on Windows; deleting it usually is not.
 */
async function rotateLockedOutfile(outfile: string): Promise<void> {
	let stats: Stats | undefined;
	try {
		stats = await fs.stat(outfile);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	if (!stats.isFile()) return;

	const rotated = `${outfile}.old.${Date.now()}`;
	try {
		await fs.rename(outfile, rotated);
	} catch {
		// If we can't rotate, Bun.build will fail with EPERM; let that surface.
		return;
	}

	// Best-effort cleanup; ignore EPERM/EBUSY if the old binary is still running.
	try {
		await fs.unlink(rotated);
	} catch {
		/* ignore */
	}
}

/**
 * Compile the coding-agent executable with its legacy Pi compatibility module
 * graph supplied by an in-memory build plugin rather than generated files.
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		// Bun.build emits an .exe extension on Windows, but callers pass the
		// base path. If a previous loom.exe is running, Bun.build can't overwrite
		// it. Rename it first; the rename itself usually succeeds even on locked
		// files. Also rotate the base path in case the target differs from host.
		const isWindowsTarget = options.target?.includes("windows") ?? process.platform === "win32";
		if (isWindowsTarget) {
			await rotateLockedOutfile(`${options.outfile}.exe`);
		}
		await rotateLockedOutfile(options.outfile);

		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
			},
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			plugins: [await createLegacyPiVirtualModulePlugin()],
			compile: {
				...(options.target ? { target: options.target } : {}),
				outfile: options.outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
	} finally {
		if (previousCodesignSetting === undefined) {
			delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
		} else {
			Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
		}
	}
}
