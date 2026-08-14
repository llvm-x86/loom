import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Text, TUI } from "@oh-my-pi/pi-tui";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { formatHyperlink } from "@oh-my-pi/pi-tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

const AUTHORIZE_URL =
	"https://claude.ai/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key&code_challenge=xyz&code_challenge_method=S256&state=6a2c05a3b248a6dd5aed60b41dca39b3";

async function settle(term: VirtualTerminal): Promise<void> {
	const immediate = Promise.withResolvers<void>();
	setImmediate(immediate.resolve);
	await immediate.promise;
	await Bun.sleep(1);
	await term.flush();
}

function extractNonEmptyOsc8Targets(chunk: string): string[] {
	const targets: string[] = [];
	for (const match of chunk.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)) {
		if (match[1]) targets.push(match[1]);
	}
	return targets;
}

describe("OAuth authorize URL hyperlinks through TUI", () => {
	const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
	const originalHyperlinks = terminalState.hyperlinks;

	beforeAll(() => {
		terminalState.hyperlinks = true;
	});

	afterAll(() => {
		terminalState.hyperlinks = originalHyperlinks;
	});

	it("emits one full-target OSC 8 opener per wrapped Text row", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term);
		const accentUrl = `\x1b[38;5;75m${AUTHORIZE_URL}\x1b[39m`;
		const linked = formatHyperlink(accentUrl, AUTHORIZE_URL);
		tui.addChild(new Text(linked, 1, 0));

		try {
			tui.start();
			await settle(term);

			const rendered = tui.render(80).join("\n");
			const linkedLines = rendered
				.split("\n")
				.filter(line => extractNonEmptyOsc8Targets(line).includes(AUTHORIZE_URL));
			expect(linkedLines.length).toBeGreaterThan(1);
			for (const line of linkedLines) {
				expect(line.split(`\x1b]8;;${AUTHORIZE_URL}\x07`)).toHaveLength(2);
			}

			const viewportText = term
				.getViewport()
				.map(line => line.trimEnd())
				.join("");
			expect(viewportText).toContain("state=6a2c05a3b248a6dd5aed60b41dca39b3");
		} finally {
			tui.stop();
		}
	});
});
