import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { LoginDialogComponent } from "@oh-my-pi/pi-coding-agent/modes/components/login-dialog";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as openModule from "@oh-my-pi/pi-coding-agent/utils/open";
import { TUI } from "@oh-my-pi/pi-tui";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const AUTHORIZE_URL =
	"https://claude.ai/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key&code_challenge=xyz&code_challenge_method=S256&state=6a2c05a3b248a6dd5aed60b41dca39b3";

const LAUNCH_URL = "http://127.0.0.1:1455/launch?state=local";

async function settle(term: VirtualTerminal): Promise<void> {
	const immediate = Promise.withResolvers<void>();
	setImmediate(immediate.resolve);
	await immediate.promise;
	await Bun.sleep(1);
	await term.flush();
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function extractNonEmptyOsc8Targets(chunk: string): string[] {
	const targets: string[] = [];
	for (const match of chunk.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)) {
		if (match[1]) targets.push(match[1]);
	}
	return targets;
}

describe("LoginDialog OAuth hyperlink e2e", () => {
	const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
	const originalHyperlinks = terminalState.hyperlinks;

	beforeAll(async () => {
		await initTheme();
		terminalState.hyperlinks = true;
		vi.spyOn(openModule, "openPath").mockImplementation(() => {});
	});

	afterAll(() => {
		terminalState.hyperlinks = originalHyperlinks;
		vi.restoreAllMocks();
	});

	it("paints every wrapped authorize URL row with the full OSC 8 target through TUI", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);
		const dialog = new LoginDialogComponent(tui, "anthropic", () => {});
		tui.addChild(dialog);

		try {
			tui.start();
			const writes = captureWrites(term);
			dialog.showAuth(AUTHORIZE_URL);
			await settle(term);

			const painted = writes.join("");
			const authorizeTargets = extractNonEmptyOsc8Targets(painted).filter(target => target === AUTHORIZE_URL);
			expect(authorizeTargets.length).toBeGreaterThan(1);

			const viewportText = term
				.getViewport()
				.map(line => line.trimEnd())
				.join("");
			expect(viewportText).toContain("claude.ai/oauth/authorize");
			expect(viewportText).toContain("state=6a2c05a3b248a6dd5aed60b41dca39b3");
		} finally {
			tui.stop();
		}
	});

	it("click hint and launch shortcut rows also target the full URL, not a wrapped fragment", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);
		const dialog = new LoginDialogComponent(tui, "anthropic", () => {});
		tui.addChild(dialog);

		try {
			tui.start();
			const writes = captureWrites(term);
			dialog.showAuth(AUTHORIZE_URL, undefined, LAUNCH_URL);
			await settle(term);

			const painted = writes.join("");
			const authorizeTargets = extractNonEmptyOsc8Targets(painted).filter(target => target === AUTHORIZE_URL);
			const launchTargets = extractNonEmptyOsc8Targets(painted).filter(target => target === LAUNCH_URL);

			expect(authorizeTargets.length).toBeGreaterThan(1);
			expect(launchTargets.length).toBeGreaterThanOrEqual(1);
			expect(painted).toContain("click to open");
		} finally {
			tui.stop();
		}
	});
});
