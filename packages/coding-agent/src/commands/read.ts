/**
 * Show what the read tool will return for a path, URL, or internal URI.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = "Show what the read tool will return for a path, URL, or internal URI";

	static args = {
		path: Args.string({
			description:
				"Path, URL, or internal URI to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		`${APP_NAME} read src/foo.ts`,
		`${APP_NAME} read src/foo.ts:50-100`,
		`${APP_NAME} read src/foo.ts:raw`,
		`${APP_NAME} read https://example.com`,
		`${APP_NAME} read loom://`,
		`${APP_NAME} read issue://123`,
		`${APP_NAME} read path/to/archive.zip:dir/file.ts`,
		`${APP_NAME} read path/to/db.sqlite:users:42`,
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
