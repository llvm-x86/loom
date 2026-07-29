import { describe, expect, it } from "bun:test";
import { formatInstallReport, type InstallReport } from "../src/webbridge/control";
import { installWindows, removeWindows } from "../src/webbridge/install/policy";
import type { CommandResult, CommandRunner } from "../src/webbridge/install/types";

const ENTRY = "abcdefghijklmnopabcdefghijklmnop;file:///C:/Users/kiosk/.loom/webbridge/update.xml";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const CHROME_HKCU = "HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist";
const CHROME_HKLM = "HKLM\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist";
const DENIED = "ERROR: Access is denied.\r\n";

const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ ok: false, stdout: "", stderr });

/** Records every invocation and answers from `replies(command, args)`. */
function recorder(replies: (command: string, args: string[]) => CommandResult) {
	const calls: string[][] = [];
	const exec: CommandRunner = async (command, args) => {
		calls.push([command, ...args]);
		return replies(command, args);
	};
	return { calls, exec };
}

describe("installWindows", () => {
	it("falls back to HKCU when the machine-wide write is denied", async () => {
		const { calls, exec } = recorder((_command, args) => {
			if (args[0] === "query") return fail("ERROR: The system was unable to find the specified registry key");
			return args[1].startsWith("HKLM") ? fail(DENIED) : ok();
		});
		const result = await installWindows({ family: "chrome", extensionId: EXTENSION_ID, system: true, exec }, ENTRY);
		expect(result.applied).toBe(true);
		expect(result.location).toBe(CHROME_HKCU);
		expect(result.message).toContain("per-user");
		expect(calls.filter(c => c[1] === "add").map(c => c[2])).toEqual([CHROME_HKLM, CHROME_HKCU]);
	});

	it("does not retry HKCU when the HKLM failure is not an access denial", async () => {
		const { calls, exec } = recorder((_command, args) =>
			args[0] === "query" ? fail("no key") : fail("ERROR: The parameter is incorrect."),
		);
		const result = await installWindows({ family: "edge", extensionId: EXTENSION_ID, system: true, exec }, ENTRY);
		expect(result.applied).toBe(false);
		expect(calls.filter(c => c[1] === "add")).toHaveLength(1);
	});

	it("returns the verbatim reg add command when the per-user write fails", async () => {
		const { exec } = recorder((_command, args) => (args[0] === "query" ? fail("no key") : fail(DENIED)));
		const result = await installWindows({ family: "chrome", extensionId: EXTENSION_ID, exec }, ENTRY);
		expect(result.applied).toBe(false);
		expect(result.message).toContain("Access is denied");
		expect(result.manualCommand).toBe(
			`reg add "${CHROME_HKCU}" \`\n  /v "1" \`\n  /t REG_SZ \`\n  /d "${ENTRY}" \`\n  /f`,
		);
	});

	it("appends after existing forcelist values and is idempotent", async () => {
		const existing = `\r\n${CHROME_HKCU}\r\n    1    REG_SZ    other;https://clients2.google.com/service/update2/crx\r\n`;
		const { calls, exec } = recorder((_command, args) => (args[0] === "query" ? ok(existing) : ok()));
		const added = await installWindows({ family: "chrome", extensionId: EXTENSION_ID, exec }, ENTRY);
		expect(added.applied).toBe(true);
		expect(calls.find(c => c[1] === "add")).toEqual([
			"reg",
			"add",
			CHROME_HKCU,
			"/v",
			"2",
			"/t",
			"REG_SZ",
			"/d",
			ENTRY,
			"/f",
		]);

		const present = `${existing}    2    REG_SZ    ${ENTRY}\r\n`;
		const { calls: second, exec: exec2 } = recorder((_command, args) => (args[0] === "query" ? ok(present) : ok()));
		const again = await installWindows({ family: "chrome", extensionId: EXTENSION_ID, exec: exec2 }, ENTRY);
		expect(again.applied).toBe(true);
		expect(again.message).toContain("already present");
		expect(second.some(c => c[1] === "add")).toBe(false);
	});
});

describe("removeWindows", () => {
	it("reports a manual reg delete when the write is denied", async () => {
		const listing = `\r\n${CHROME_HKCU}\r\n    3    REG_SZ    ${ENTRY}\r\n`;
		const { exec } = recorder((_command, args) => (args[0] === "query" ? ok(listing) : fail(DENIED)));
		const result = await removeWindows({ family: "chrome", extensionId: EXTENSION_ID, exec });
		expect(result.applied).toBe(false);
		expect(result.manualCommand).toBe(`reg delete "${CHROME_HKCU}" /v "3" /f`);
	});
});

describe("formatInstallReport manual commands", () => {
	const report = (manualCommand?: string): InstallReport => ({
		destDir: "C:\\Users\\kiosk\\.loom\\webbridge\\extension",
		dev: false,
		noBrowsers: false,
		extensionId: EXTENSION_ID,
		results: [
			{
				family: "chrome",
				applied: false,
				location: CHROME_HKCU,
				message: "Could not write the force-install policy: ERROR: Access is denied.",
				manualCommand,
			},
		],
	});

	it("prints the manual command block when one is available", () => {
		const command = `reg add "${CHROME_HKCU}" /v "1" /t REG_SZ /d "${ENTRY}" /f`;
		const out = formatInstallReport(report(command));
		expect(out).toContain("Run these yourself to apply the policy:");
		expect(out).toContain(command);
		expect(out).toContain("Load unpacked");
	});

	it("never dangles a 'printed commands' clause when nothing was printed", () => {
		const out = formatInstallReport(report());
		expect(out).not.toContain("printed commands");
		expect(out).not.toContain("Run these yourself");
		expect(out).toContain("Or load the extension manually:");
		expect(out).toContain("Load unpacked");
	});
});
