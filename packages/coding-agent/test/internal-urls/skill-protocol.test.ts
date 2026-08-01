import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetActiveSkillsForTests } from "../../src/extensibility/skills";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { SkillProtocolHandler } from "../../src/internal-urls/skill-protocol";

describe("SkillProtocolHandler on-demand fallback", () => {
	it("resolves skill://<name> from disk when the skill is not in the active snapshot", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-skill-fallback-"));
		const skillName = `loom-fallback-test-${Date.now()}`;
		const skillDir = path.join(tmp, ".loom", "skills", skillName);
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			`---\nname: ${skillName}\ndescription: Test fallback skill\n---\n\nHello from fallback.\n`,
		);

		resetActiveSkillsForTests();

		const handler = new SkillProtocolHandler();
		const url = parseInternalUrl(`skill://${skillName}`);
		const resource = await handler.resolve(url, { cwd: tmp });

		expect(resource.content).toContain("Hello from fallback.");
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.sourcePath).toBe(path.join(skillDir, "SKILL.md"));
	});

	it("still throws when the skill is neither active nor on disk", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loom-skill-missing-"));
		resetActiveSkillsForTests();

		const handler = new SkillProtocolHandler();
		const url = parseInternalUrl("skill://missing-skill");
		await expect(handler.resolve(url, { cwd: tmp })).rejects.toThrow("Unknown skill: missing-skill");
	});
});
