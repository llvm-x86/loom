/**
 * The MV3 WebBridge extension, embedded as text so it ships inside the compiled
 * `loom` binary. {@link installWebBridgeExtension} materializes the files to a
 * directory the user can load unpacked in Chrome/Edge.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import backgroundJs from "./ext/background.js" with { type: "text" };
import manifest from "./ext/manifest.json";

export const WEBBRIDGE_EXT_FILES: Record<string, string> = {
	"manifest.json": `${JSON.stringify(manifest, null, "\t")}\n`,
	"background.js": backgroundJs,
};

/** Write the extension files to `destDir` (created if needed). Returns `destDir`. */
export async function installWebBridgeExtension(destDir: string): Promise<string> {
	await fs.mkdir(destDir, { recursive: true });
	for (const [name, content] of Object.entries(WEBBRIDGE_EXT_FILES)) {
		await fs.writeFile(path.join(destDir, name), content, "utf8");
	}
	return destDir;
}
