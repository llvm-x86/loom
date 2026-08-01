import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function writeArgs(lineCount: number) {
	return {
		path: "notes.txt",
		content: Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n"),
	};
}

function partialWriteResult(text = "Writing notes.txt...") {
	return { content: [{ type: "text", text }] };
}

class Footer implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `editor-${i}`);
	}
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

// `resetDisplay()` only clears native scrollback (ED3) where that is safe. Inside
// a terminal multiplexer it must not: tmux/screen/zellij pane history belongs to
// the user, so the engine re-anchors and recommits below the stale frame instead
// (duplication, never loss). The buffer-level test below asserts the stale rows
// are *removed*, which is the direct-terminal contract, so it has to pin the
// environment — a suite running inside a multiplexer (CI-in-tmux, an agent pane)
// otherwise exercises the re-anchor branch and still sees the pending tail. TERM
// is pinned too: the detector falls back to the `tmux-*`/`screen-*` TERM prefix
// when the session env vars are stripped (`sudo` without -E, sanitizing launchers).
const NO_MULTIPLEXER_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	CMUX_WORKSPACE_ID: undefined,
	CMUX_SURFACE_ID: undefined,
	CMUX_REMOTE_TRANSPORT: undefined,
	TERM: "xterm-256color",
};

/** Apply an env patch, returning the restore thunk. */
function patchEnv(patch: Record<string, string | undefined>): () => void {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	return () => {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	};
}

describe("ToolExecutionComponent write repaint seam", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
	});

	function makeComponent(args: unknown) {
		const resetDisplay = vi.fn();
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay } as unknown as TUI;
		const component = new ToolExecutionComponent("write", args, {}, undefined, ui);
		components.push(component);
		resetDisplay.mockClear();
		return { component, resetDisplay };
	}

	it("forces a viewport repaint when a painted collapsed tail window receives its first result", () => {
		// 20 lines > WRITE_STREAMING_PREVIEW_LINES (12): the pending preview is a
		// tail window the first-result render re-anchors to the top of the file.
		const { component, resetDisplay } = makeComponent(writeArgs(20));
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the pending tail window never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent(writeArgs(20));
		// No render() before the result: a resetDisplay here would wipe native
		// scrollback for a shape the user never saw.

		component.updateResult(partialWriteResult(), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint a collapsed preview that fits the streaming window", () => {
		// 12 lines render top-anchored without a tail window, so the first result
		// does not re-anchor the frame; wiping scrollback would be gratuitous.
		const { component, resetDisplay } = makeComponent(writeArgs(12));
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint an expanded pending preview", () => {
		// Expanded previews show the whole file top-anchored — no tail window to
		// re-anchor.
		const { component, resetDisplay } = makeComponent(writeArgs(20));
		component.setExpanded(true);
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("removes stale pending tail rows from the terminal buffer when the first partial result arrives", async () => {
		const restoreEnv = patchEnv(NO_MULTIPLEXER_ENV);
		const term = new VirtualTerminal(80, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = new ToolExecutionComponent("write", writeArgs(20), {}, undefined, tui);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await scheduler.drain(term);
			const pendingRows = plainBuffer(term);
			expect(pendingRows.some(row => row.includes("… (8 earlier lines)"))).toBe(true);
			expect(pendingRows.some(row => row.includes("… (streaming)"))).toBe(true);
			expect(pendingRows.some(row => row.includes("20 line 20"))).toBe(true);

			component.setArgsComplete();
			tui.requestRender();
			await scheduler.drain(term);

			component.updateResult(partialWriteResult(), true);
			tui.requestRender();
			await scheduler.drain(term);

			const rows = plainBuffer(term);
			// The stale pending tail window must not survive above the new frame.
			expect(rows.some(row => row.includes("… (streaming)"))).toBe(false);
			expect(rows.some(row => row.includes("earlier lines"))).toBe(false);
			expect(rows.some(row => row.includes("20 line 20"))).toBe(false);
			// The first partial-result frame is what remains: progress line plus the
			// top-anchored preview.
			expect(rows.some(row => row.includes("Writing notes.txt..."))).toBe(true);
			expect(rows.some(row => row.includes("  1 line 1"))).toBe(true);
			expect(rows.some(row => row.includes("… 14 more lines"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
			restoreEnv();
		}
	});
});
