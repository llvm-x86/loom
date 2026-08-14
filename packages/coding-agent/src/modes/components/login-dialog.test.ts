import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "../theme/theme";
import { LoginDialogComponent } from "./login-dialog";

/** Minimal TUI stub — the dialog only calls requestRender/setFocus. */
function makeDialog(): LoginDialogComponent {
	const tui = { requestRender() {}, setFocus() {} } as unknown as TUI;
	return new LoginDialogComponent(tui, "openai-codex", () => {});
}

describe("LoginDialogComponent manual code input", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("captures a pasted fallback redirect URL and resolves on submit", async () => {
		// Regression for #5339: paste-code providers (Codex) route the fallback
		// URL through the focused dialog. Without a mounted input, the paste is
		// dropped and login never completes.
		const dialog = makeDialog();
		dialog.showProgress("Waiting for callback");

		const pending = dialog.showManualInput("Paste the authorization code:");
		expect(dialog.render(80).join("\n")).toContain("Paste the authorization code");

		const url = "http://localhost:1455/auth/callback?code=THECODE&state=abc";
		dialog.pasteText(url);
		dialog.handleInput("\r");

		expect(await pending).toBe(url);
	});

	it("reuses the mounted input across re-prompts instead of stacking duplicates", async () => {
		// The OAuth callback loop re-invokes onManualCodeInput after an invalid
		// paste; the second prompt must not append a duplicate input/hint block.
		const dialog = makeDialog();
		dialog.showProgress("Waiting for callback");

		const first = dialog.showManualInput("Paste the code:");
		dialog.handleInput("garbage");
		dialog.handleInput("\r");
		expect(await first).toBe("garbage");

		const second = dialog.showManualInput("Paste the code:");
		const rendered = dialog.render(80).join("\n");
		expect(rendered.split("Paste the code:").length - 1).toBe(1);
		// A stale value from the first attempt must not leak into the retry.
		expect(rendered).not.toContain("garbage");

		const url = "http://localhost:1455/auth/callback?code=OK&state=abc";
		dialog.pasteText(url);
		dialog.handleInput("\r");
		expect(await second).toBe(url);
	});
});

describe("LoginDialogComponent OAuth URL hyperlinks", () => {
	const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
	const originalHyperlinks = terminalState.hyperlinks;

	beforeAll(async () => {
		await initTheme();
		terminalState.hyperlinks = true;
	});

	afterAll(() => {
		terminalState.hyperlinks = originalHyperlinks;
	});

	function inspectHyperlinkTargets(line: string): Array<string | null> {
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

	it("balances the full authorize URL across wrapped display rows", () => {
		const dialog = makeDialog();
		const url =
			"https://claude.ai/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key&code_challenge=xyz&code_challenge_method=S256&state=6a2c05a3b248a6dd5aed60b41dca39b3";

		dialog.showAuth(url);
		const linkedLines = dialog.render(80).filter(line => inspectHyperlinkTargets(line).includes(url));

		expect(linkedLines.length).toBeGreaterThan(1);
		for (const line of linkedLines) {
			expect(line.split(`\x1b]8;;${url}\x07`)).toHaveLength(2);
			expect(line.match(/\x1b\]8;;\x07/g)).toHaveLength(1);
		}
	});
});
