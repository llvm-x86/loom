/**
 * List and clean up per-run scratch dirs under `~/.loom/scratch`.
 */
import { APP_NAME, CONFIG_DIR_NAME, getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { clearScratch, listScratch } from "../cli/scratch-cli";
import { Settings } from "../config/settings";

export default class Scratch extends Command {
	static description = `List or clear per-run scratch dirs (~/${CONFIG_DIR_NAME}/scratch)`;

	static args = {
		// `list` (default) inspects the scratch root; `clear` removes entries.
		// A positional action keeps `loom scratch` (the no-arg form) useful.
		action: Args.string({
			description: "list (default) or clear",
			required: false,
			options: ["list", "clear"],
			default: "list",
		}),
	};

	static flags = {
		all: Flags.boolean({
			description:
				"Clear every entry without a live owner, including ones still inside the grace window (clear). Dirs owned by a live process are never removed.",
			default: false,
		}),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Print what would be removed without touching the filesystem (clear)",
			default: false,
		}),
		yes: Flags.boolean({
			char: "y",
			description:
				"Confirm --all against the default scratch root. Required there because --all waives the forensics grace for every crashed run in the fleet; an explicitly configured root (OMP_SCRATCH_DIR or scratch.base) needs no confirmation.",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
	};

	static examples = [
		`${APP_NAME} scratch`,
		`${APP_NAME} scratch list --json`,
		`${APP_NAME} scratch clear`,
		`${APP_NAME} scratch clear --dry-run`,
		`${APP_NAME} scratch clear --all --yes`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Scratch);
		// Load settings so the `scratch.base` override is applied before we scan
		// — otherwise this command would inspect ~/.loom/scratch while the agent
		// created its scratch dirs under the configured base.
		await Settings.init({ cwd: getProjectDir() });
		if (args.action === "clear") {
			await clearScratch({
				all: flags.all ?? false,
				dryRun: flags["dry-run"] ?? false,
				yes: flags.yes ?? false,
				json: flags.json ?? false,
			});
			return;
		}
		await listScratch({ json: flags.json ?? false });
	}
}
