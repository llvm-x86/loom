/**
 * Inspect and manually run the long-term memory layers. Currently one group:
 * `loom memory wiki <status|index|log|impact|run>` over the mnemopi wiki layer.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { type MemoryWikiAction, type MemoryWikiCommandArgs, runMemoryWikiCommand } from "../cli/memory-wiki-cli";

const GROUPS = ["wiki"];
const WIKI_ACTIONS: MemoryWikiAction[] = ["status", "index", "log", "impact", "run"];

export default class Memory extends Command {
	static description = "Inspect or run the memory wiki layer (compiled patterns over raw mnemopi rows)";

	static args = {
		group: Args.string({
			description: "Memory layer to operate on",
			required: false,
			options: GROUPS,
		}),
		action: Args.string({
			description: "status | index | log | impact | run",
			required: false,
			options: WIKI_ACTIONS,
		}),
	};

	static flags = {
		bank: Flags.string({
			description: "Bank id or owner/repo slug (default: every bank in the mnemopi store)",
		}),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		limit: Flags.integer({ description: "Newest N entries to show (log, impact)" }),
		skills: Flags.boolean({ description: "Also run the skill proposer after the maintainer (run)", default: false }),
		"dry-run": Flags.boolean({
			char: "n",
			description: "Print the prompt(s) a pass would send instead of calling a model; writes nothing (run)",
			default: false,
		}),
	};

	static examples = [
		`${APP_NAME} memory wiki status`,
		`${APP_NAME} memory wiki status --json`,
		`${APP_NAME} memory wiki index --bank owner/repo`,
		`${APP_NAME} memory wiki log --limit 5`,
		`${APP_NAME} memory wiki impact`,
		`${APP_NAME} memory wiki run --dry-run`,
		`${APP_NAME} memory wiki run --skills --bank owner/repo`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Memory);
		if (!args.group || !args.action) {
			renderCommandHelp(APP_NAME, "memory", Memory);
			return;
		}
		const cmd: MemoryWikiCommandArgs = {
			action: args.action as MemoryWikiAction,
			flags: {
				bank: flags.bank,
				json: flags.json,
				limit: flags.limit,
				skills: flags.skills,
				dryRun: flags["dry-run"],
			},
		};
		await runMemoryWikiCommand(cmd);
	}
}
