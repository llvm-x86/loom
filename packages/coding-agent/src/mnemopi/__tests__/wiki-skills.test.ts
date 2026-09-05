import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { getManagedSkillsDir, writeManagedSkill } from "../../autolearn/managed-skills";
import { RAW_MEMORY_TYPE, RAW_SOURCE, WikiStore } from "../wiki";
import {
	bodyMentionsFix,
	type Complete,
	fixSectionOf,
	parsePurposeFile,
	renderPurposeFile,
	runSkillProposerPass,
	selectCandidates,
	toEpochSeconds,
	unifiedDiff,
} from "../wiki-skills";

const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir = "";

beforeEach(() => {
	agentDir = mkdtempSync(path.join(tmpdir(), "loom-wiki-skills-agent-"));
	tempDirs.push(agentDir);
	setAgentDir(agentDir);
});
afterEach(() => {
	setAgentDir(originalAgentDir);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A file-backed bank with one raw transcript row per session, each retained by that session's own handle. */
function bankWithRaw(sessions: string[]): { memory: Mnemopi; rawIds: string[] } {
	const dir = mkdtempSync(path.join(tmpdir(), "loom-wiki-skills-test-"));
	tempDirs.push(dir);
	const dbPath = path.join(dir, "mnemopi.db");
	const rawIds = sessions.map((sessionId, i) => {
		const lane = new Mnemopi({ dbPath, sessionId, bank: "testbank", llmEnabled: false });
		const id = lane.remember(`transcript ${i}: the deploy said success but the container was never replaced`, {
			source: RAW_SOURCE,
			memoryType: RAW_MEMORY_TYPE,
			importance: 0.5,
		});
		lane.close();
		return id;
	});
	return { memory: new Mnemopi({ dbPath, sessionId: "lane-a", bank: "testbank", llmEnabled: false }), rawIds };
}

const PATTERN_BODY = [
	"PROBLEM deploy reports success while the old container keeps serving; ROOT CAUSE image tag reused; FIX compare container ctime with the deploy time.",
	"",
	"## Problem",
	"The deploy tool prints success but requests still hit the previous build.",
	"",
	"## Root cause",
	"The image tag was reused, so the orchestrator saw nothing to replace.",
	"",
	"## Fix",
	"Run `docker inspect --format '{{.Created}}' <container>` and compare it with the deploy timestamp; a container older than the deploy was never replaced.",
].join("\n");

const SKILL_BODY = [
	"# Verify a deploy actually replaced the container",
	"",
	"After every deploy, before reporting success:",
	"",
	"1. `docker ps --format '{{.Names}} {{.CreatedAt}}'` and find the app container.",
	"2. `docker inspect --format '{{.Created}}' <container>` — the timestamp MUST be newer than the deploy start.",
	"3. If it is older, the image tag was reused and nothing was replaced: rebuild with a fresh tag and deploy again.",
	"4. Only then report success, quoting the container's Created time.",
	"",
	"A deploy log that says success is not evidence; the container ctime is.",
].join("\n");

const PATCHED_BODY = SKILL_BODY.replace(
	"4. Only then report success, quoting the container's Created time.",
	"4. Only then report success, quoting the container's Created time AND the image digest.",
);

/** A fake LLM that hands out `responses` in order and records every prompt it saw. */
function fakeComplete(responses: Array<string | null>): { complete: Complete; prompts: string[] } {
	const prompts: string[] = [];
	const queue = [...responses];
	return {
		prompts,
		complete: async (prompt: string) => {
			prompts.push(prompt);
			return queue.length > 0 ? (queue.shift() as string | null) : null;
		},
	};
}

function proposal(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		action: "create",
		name: "deploy-verify",
		description: "Use after any deploy to prove the running container was actually replaced.",
		body: SKILL_BODY,
		purpose: "Deploys that report success while the old container keeps serving recur across lanes.",
		patterns: ["deploy-success-live"],
		reason: "recurs in 2 sessions",
		...overrides,
	});
}

const ACCEPT = JSON.stringify({ accept: true, reason: "concrete commands, prevents the cited failure" });
const REJECT = JSON.stringify({ accept: false, reason: "generic advice" });

function skillDir(name: string): string {
	return path.join(getManagedSkillsDir(agentDir), name);
}

describe("bodyMentionsFix", () => {
	it("finds a 12+ char token run from the ## Fix section, case-insensitively, and rejects a body without one", () => {
		expect(bodyMentionsFix(SKILL_BODY, PATTERN_BODY)).toBe(true);
		expect(bodyMentionsFix(SKILL_BODY.toUpperCase(), PATTERN_BODY)).toBe(true);
		expect(bodyMentionsFix("Be careful with deploys and verify your work thoroughly every time.", PATTERN_BODY)).toBe(
			false,
		);
		// Single shared words do not count: the run must be long enough to be a specific phrase.
		expect(bodyMentionsFix("docker is great and deploy is fun", PATTERN_BODY)).toBe(false);
	});

	it("falls back to the FIX clause of the index line when there is no ## Fix heading", () => {
		const bare = "PROBLEM x; ROOT CAUSE y; FIX run git var GIT_AUTHOR_IDENT before committing.";
		expect(fixSectionOf(bare)).toBe("run git var GIT_AUTHOR_IDENT before committing.");
		expect(bodyMentionsFix("Always run git var GIT_AUTHOR_IDENT first.", bare)).toBe(true);
		expect(bodyMentionsFix("Always run git status first.", bare)).toBe(false);
	});
});

describe("unifiedDiff", () => {
	it("renders a create as all additions and a patch as the changed lines with context", () => {
		const created = unifiedDiff("", "a\nb\nc");
		expect(created.split("\n").slice(0, 2)).toEqual(["--- a/SKILL.md", "+++ b/SKILL.md"]);
		expect(created.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"))).toEqual(["+a", "+b", "+c"]);
		const patched = unifiedDiff("a\nb\nc\nd", "a\nB\nc\nd");
		expect(patched).toContain("-b");
		expect(patched).toContain("+B");
		expect(patched).not.toContain("-a");
		expect(patched).not.toContain("+d");
		expect(unifiedDiff("same", "same")).toBe("");
	});

	it("caps the output at maxLines", () => {
		const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
		const diff = unifiedDiff("", big);
		expect(diff.split("\n").length).toBeLessThanOrEqual(60);
		expect(diff).toContain("more lines");
	});
});

describe("PURPOSE.md", () => {
	it("round-trips purpose text and cited slugs", () => {
		const text = renderPurposeFile({ purpose: "Why this skill exists.", patterns: ["a-slug", "b-slug"] });
		expect(parsePurposeFile(text)).toEqual({ purpose: "Why this skill exists.", patterns: ["a-slug", "b-slug"] });
		expect(parsePurposeFile("just prose")).toEqual({ purpose: "just prose", patterns: [] });
	});
});

describe("selectCandidates", () => {
	it("compares SQLite created_at and ISO updated_at on the same clock", () => {
		expect(toEpochSeconds("2026-09-04 10:00:00")).toBe(toEpochSeconds("2026-09-04T10:00:00.900Z"));
		const pattern = {
			id: "p",
			slug: "p",
			indexLine: "",
			body: "",
			evidence: ["r1", "r2"],
			sessions: ["s1", "s2"],
			skills: [],
			version: 1,
			createdAt: "",
			updatedAt: "2026-09-04T10:00:00.900Z",
		};
		const rejected = (at: string) => ({
			at,
			action: "create" as const,
			skill: "x",
			patterns: ["p"],
			diff: "",
			decision: "rejected" as const,
			reason: "",
		});
		expect(selectCandidates([pattern], [rejected("2026-09-04 09:59:59")], 2)).toHaveLength(1);
		expect(selectCandidates([pattern], [rejected("2026-09-04 10:00:00")], 2)).toHaveLength(0);
		expect(selectCandidates([pattern], [], 3)).toHaveLength(0);
		expect(selectCandidates([{ ...pattern, skills: ["already"] }], [], 2)).toHaveLength(0);
	});
});

describe("runSkillProposerPass", () => {
	it("skips without an LLM and writes nothing", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		expect(await runSkillProposerPass(store, { agentDir })).toMatchObject({ skipped: "no-llm", action: "no_action" });
		expect(store.listSkillImpact()).toHaveLength(0);
		memory.close();
	});

	it("does not treat a single-session pattern as a candidate", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		const llm = fakeComplete([proposal(), ACCEPT]);
		const result = await runSkillProposerPass(store, { complete: llm.complete, agentDir });
		expect(result).toMatchObject({ skipped: "no-candidates", action: "no_action", skill: null, decision: null });
		expect(llm.prompts).toHaveLength(0);
		expect(store.listSkillImpact()).toHaveLength(0);
		expect(existsSync(getManagedSkillsDir(agentDir))).toBe(false);
		memory.close();
	});

	it("creates a skill from a recurring pattern: files, citation tag, and an ACCEPTED diff in the audit trail", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		const before = store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		const llm = fakeComplete([proposal(), ACCEPT]);
		const result = await runSkillProposerPass(store, { complete: llm.complete, agentDir });
		expect(result).toMatchObject({ action: "create", skill: "deploy-verify", decision: "accepted" });
		expect(result.skipped).toBeUndefined();
		expect(llm.prompts).toHaveLength(2);
		// The paper rule is in the prompt: one atomic change per pass.
		expect(llm.prompts[0]).toContain("AT MOST ONE");
		expect(llm.prompts[0]).toContain("deploy-success-live");
		expect(llm.prompts[1]).toContain("avoid the cited failures");

		const skillMd = readFileSync(path.join(skillDir("deploy-verify"), "SKILL.md"), "utf8");
		expect(skillMd).toContain("name: deploy-verify");
		expect(skillMd).toContain("docker inspect --format");
		const purpose = parsePurposeFile(readFileSync(path.join(skillDir("deploy-verify"), "PURPOSE.md"), "utf8"));
		expect(purpose.patterns).toEqual(["deploy-success-live"]);
		expect(purpose.purpose).toContain("recur across lanes");
		// SKILL.md itself carries no provenance block.
		expect(skillMd).not.toContain("patterns:");

		const after = store.getPattern("deploy-success-live");
		expect(after?.skills).toEqual(["deploy-verify"]);
		expect(after?.body).toBe(before.body);
		expect(after?.evidence.sort()).toEqual([...rawIds].sort());

		const impact = store.listSkillImpact();
		expect(impact).toHaveLength(1);
		expect(impact[0]).toMatchObject({
			action: "create",
			skill: "deploy-verify",
			patterns: ["deploy-success-live"],
			decision: "accepted",
		});
		expect(impact[0]?.diff).toContain("+++ b/SKILL.md");
		expect(impact[0]?.diff).toContain("+# Verify a deploy actually replaced the container");
		memory.close();
	});

	it("patches an existing skill in place and records the changed lines", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		await writeManagedSkill({
			action: "create",
			name: "deploy-verify",
			description: "old description",
			body: SKILL_BODY,
		});
		const llm = fakeComplete([proposal({ action: "patch", body: PATCHED_BODY }), ACCEPT]);
		const result = await runSkillProposerPass(store, { complete: llm.complete, agentDir });
		expect(result).toMatchObject({ action: "patch", skill: "deploy-verify", decision: "accepted" });
		expect(llm.prompts[0]).toContain("old description");

		const skillMd = readFileSync(path.join(skillDir("deploy-verify"), "SKILL.md"), "utf8");
		expect(skillMd).toContain("AND the image digest");
		expect(skillMd).not.toContain("old description");
		expect(existsSync(path.join(skillDir("deploy-verify"), "PURPOSE.md"))).toBe(true);
		expect(store.getPattern("deploy-success-live")?.skills).toEqual(["deploy-verify"]);

		const diff = store.listSkillImpact()[0]?.diff ?? "";
		expect(diff).toContain("-4. Only then report success, quoting the container's Created time.");
		expect(diff).toContain(
			"+4. Only then report success, quoting the container's Created time AND the image digest.",
		);
		expect(diff).not.toContain("-1. `docker ps");
		memory.close();
	});

	it("rejects an invalid skill name at the gate without touching disk or calling the judge", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		const llm = fakeComplete([proposal({ name: "../Evil Skill" }), ACCEPT]);
		const result = await runSkillProposerPass(store, { complete: llm.complete, agentDir });
		expect(result).toMatchObject({ action: "create", skill: null, decision: "rejected" });
		expect(result.reason).toContain("invalid skill name");
		expect(llm.prompts).toHaveLength(1);
		expect(existsSync(getManagedSkillsDir(agentDir))).toBe(false);
		expect(store.getPattern("deploy-success-live")?.skills).toEqual([]);
		expect(store.listSkillImpact()[0]).toMatchObject({ decision: "rejected", diff: "" });
		memory.close();
	});

	it("rejects a body that does not restate the cited fix", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		const vague = `# Deploy carefully\n\n${"Always double check the deploy went well and verify everything before you report. ".repeat(6)}`;
		const llm = fakeComplete([proposal({ body: vague }), ACCEPT]);
		const result = await runSkillProposerPass(store, { complete: llm.complete, agentDir });
		expect(result).toMatchObject({ decision: "rejected", skill: "deploy-verify" });
		expect(result.reason).toContain("does not restate the fix");
		expect(existsSync(getManagedSkillsDir(agentDir))).toBe(false);
		memory.close();
	});

	it("records a judge rejection so the next pass has no candidates", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		const first = fakeComplete([proposal(), REJECT]);
		const result = await runSkillProposerPass(store, { complete: first.complete, agentDir });
		expect(result).toMatchObject({
			action: "create",
			skill: "deploy-verify",
			decision: "rejected",
			reason: "generic advice",
		});
		expect(existsSync(getManagedSkillsDir(agentDir))).toBe(false);
		expect(store.getPattern("deploy-success-live")?.skills).toEqual([]);
		expect(store.renderSkillImpact()).toContain(
			"REJECTED create deploy-verify: generic advice [deploy-success-live]",
		);

		const second = fakeComplete([proposal(), ACCEPT]);
		expect(await runSkillProposerPass(store, { complete: second.complete, agentDir })).toMatchObject({
			skipped: "no-candidates",
		});
		expect(second.prompts).toHaveLength(0);
		expect(store.listSkillImpact()).toHaveLength(1);
		memory.close();
	});

	it("treats a null or non-JSON proposer reply as malformed output and writes nothing", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		expect(await runSkillProposerPass(store, { complete: fakeComplete([null]).complete, agentDir })).toMatchObject({
			skipped: "malformed-output",
			decision: null,
		});
		expect(
			await runSkillProposerPass(store, { complete: fakeComplete(["Sure! Here is my plan."]).complete, agentDir }),
		).toMatchObject({ skipped: "malformed-output" });
		expect(store.listSkillImpact()).toHaveLength(0);
		expect(existsSync(getManagedSkillsDir(agentDir))).toBe(false);
		memory.close();
	});

	it("logs a no_action verdict as an accepted no_action entry", async () => {
		const { memory, rawIds } = bankWithRaw(["lane-a", "lane-b"]);
		const store = new WikiStore("testbank", memory);
		store.createPattern({ slug: "deploy-success-live", body: PATTERN_BODY, evidence: rawIds });
		const llm = fakeComplete([JSON.stringify({ action: "no_action", reason: "one pattern is not enough yet" })]);
		const result = await runSkillProposerPass(store, { complete: llm.complete, agentDir });
		expect(result).toEqual({
			action: "no_action",
			skill: null,
			decision: "accepted",
			reason: "one pattern is not enough yet",
		});
		expect(store.listSkillImpact()[0]).toMatchObject({ action: "no_action", decision: "accepted" });
		expect(readdirSync(agentDir)).toEqual([]);
		memory.close();
	});
});
