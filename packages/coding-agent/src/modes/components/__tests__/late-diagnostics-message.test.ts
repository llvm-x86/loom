import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../config/settings";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { LateDiagnosticsMessageComponent } from "../late-diagnostics-message";

const strip = (lines: readonly string[]): string =>
	lines
		.join("\n")
		.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;]*m/g, "");

describe("LateDiagnosticsMessageComponent", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	const files = [
		{
			path: "bad.py",
			summary: "1 error(s)",
			errored: true,
			messages: ["bad.py:4:12 [error] boom (reportReturnType)"],
		},
	];

	it("titles the card for the mention that produced it", () => {
		const text = strip(
			new LateDiagnosticsMessageComponent(files, "@zed-diagnostics (basedpyright, ruff)").render(80),
		);
		expect(text).toContain("@zed-diagnostics (basedpyright, ruff)");
		expect(text).toContain("bad.py");
		expect(text).toContain("reportReturnType");
	});

	it("keeps the late-diagnostics title by default", () => {
		expect(strip(new LateDiagnosticsMessageComponent(files).render(80))).toContain("Late diagnostics");
	});
});
