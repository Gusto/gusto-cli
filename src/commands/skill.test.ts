import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExitCode } from "../lib/exit-codes.ts";
import type { GlobalFlags } from "../lib/global-flags.ts";
import type { SkillsDir } from "../lib/skills.ts";
import { installSkill } from "../lib/skills.ts";
import { skillInstallHandler, skillListHandler } from "./skill.ts";

const globals: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };
const ctx = { command: "gusto skill", globals };

let scratch: string;
let dir: SkillsDir;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-skill-cmd-"));
  dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude", scope: "local" };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("skillListHandler", () => {
  test("decorates every bundled skill with name, description, and status", async () => {
    const result = await skillListHandler(dir)(ctx);
    expect(result.ok).toBe(true);
    const { skills } = (result as { data: { skills: Array<{ name: string; description: string; status: string }> } })
      .data;
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(["not_installed", "installed", "stale"]).toContain(skill.status);
    }
  });

  test("reports status='not_installed' before install and 'installed' after", async () => {
    const before = (await skillListHandler(dir)(ctx)) as { data: { skills: Array<{ name: string; status: string }> } };
    expect(before.data.skills.find((s) => s.name === "onboard-company")?.status).toBe("not_installed");

    await installSkill("onboard-company", dir);

    const after = (await skillListHandler(dir)(ctx)) as { data: { skills: Array<{ name: string; status: string }> } };
    expect(after.data.skills.find((s) => s.name === "onboard-company")?.status).toBe("installed");
  });
});

describe("skillInstallHandler", () => {
  test("installs a known skill and returns the install action", async () => {
    const result = (await skillInstallHandler("onboard-company", dir)(ctx)) as {
      ok: boolean;
      data: { skill: string; action: string };
    };
    expect(result.ok).toBe(true);
    expect(result.data.skill).toBe("onboard-company");
    expect(result.data.action).toBe("installed");
  });

  test("returns a validation error for an unknown skill", async () => {
    const result = await skillInstallHandler("not-a-skill", dir)(ctx);
    expect(result.ok).toBe(false);
    expect((result as { exitCode: number }).exitCode).toBe(ExitCode.Validation);
    expect((result as { error: { code: string } }).error.code).toBe("unknown_skill");
  });
});
