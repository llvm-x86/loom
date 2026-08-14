import { describe, expect, it } from "bun:test";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { formatHyperlink, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/utils";

describe("formatHyperlink", () => {
	const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
	const originalHyperlinks = terminalState.hyperlinks;

	function inspectHyperlinks(line: string): Array<string | null> {
		const targets: Array<string | null> = [];
		let activeTarget: string | null = null;

		for (let i = 0; i < line.length; ) {
			if (line.startsWith("\x1b]8;;", i)) {
				const terminator = line.indexOf("\x07", i + 5);
				activeTarget = line.slice(i + 5, terminator) || null;
				i = terminator + 1;
				continue;
			}
			if (line.startsWith("\x1b[", i)) {
				i += 2;
				while (i < line.length && (line.charCodeAt(i) < 0x40 || line.charCodeAt(i) > 0x7e)) i++;
				i++;
				continue;
			}

			targets.push(activeTarget);
			i++;
		}

		return targets;
	}

	it("balances the full target on every wrapped OAuth URL fragment", () => {
		terminalState.hyperlinks = true;

		const url =
			"https://claude.ai/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key&code_challenge=xyz&code_challenge_method=S256&state=6a2c05a3b248a6dd5aed60b41dca39b3";
		const styled = `\x1b[38;5;75m${url}\x1b[39m`;
		const linked = formatHyperlink(styled, url);
		const wrapped = wrapTextWithAnsi(linked, 80);

		expect(wrapped.length).toBeGreaterThan(1);
		for (const line of wrapped) {
			expect(line.split(`\x1b]8;;${url}\x07`)).toHaveLength(2);
			expect(line.match(/\x1b\]8;;\x07/g)).toHaveLength(1);
			expect(new Set(inspectHyperlinks(line).filter(target => target !== null))).toEqual(new Set([url]));
		}

		terminalState.hyperlinks = originalHyperlinks;
	});

	it("returns text unchanged when hyperlinks are disabled", () => {
		terminalState.hyperlinks = false;
		expect(formatHyperlink("open me", "https://example.com")).toBe("open me");
		terminalState.hyperlinks = originalHyperlinks;
	});
});
