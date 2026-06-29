import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { ExitCode } from "../lib/exit-codes.ts";
import type { SkillsDir } from "../lib/skills.ts";
import { installSkill } from "../lib/skills.ts";
import { TEST_CONTEXT as ctx, makeScratch, removeScratch } from "../lib/test-support.ts";
import { skillInstallHandler, skillListHandler } from "./skill.ts";

let scratch: string;
let dir: SkillsDir;

beforeEach(() => {
  scratch = makeScratch("gusto-cli-skill-cmd-");
  dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude", scope: "local" };
});

afterEach(() => {
  removeScratch(scratch);
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
    expect(before.data.skills.find((s) => s.name === "cash-forecasting")?.status).toBe("not_installed");

    await installSkill("cash-forecasting", dir);

    const after = (await skillListHandler(dir)(ctx)) as { data: { skills: Array<{ name: string; status: string }> } };
    expect(after.data.skills.find((s) => s.name === "cash-forecasting")?.status).toBe("installed");
  });
});

describe("skillInstallHandler", () => {
  test("installs a known skill and returns the install action", async () => {
    const result = (await skillInstallHandler("cash-forecasting", {}, dir)(ctx)) as {
      ok: boolean;
      data: { skill: string; action: string };
    };
    expect(result.ok).toBe(true);
    expect(result.data.skill).toBe("cash-forecasting");
    expect(result.data.action).toBe("installed");
  });

  test("returns a validation error for an unknown skill", async () => {
    const result = await skillInstallHandler("not-a-skill", {}, dir)(ctx);
    expect(result.ok).toBe(false);
    expect((result as { exitCode: number }).exitCode).toBe(ExitCode.Validation);
    expect((result as { error: { code: string } }).error.code).toBe("unknown_skill");
  });

  test("--all installs every bundled skill", async () => {
    const result = (await skillInstallHandler(undefined, { all: true }, dir)(ctx)) as {
      ok: boolean;
      data: { skills: Array<{ skill: string; action: string }> };
    };
    expect(result.ok).toBe(true);
    expect(result.data.skills.length).toBeGreaterThan(0);
    for (const s of result.data.skills) expect(s.action).toBe("installed");
  });

  test("--all combined with a name is rejected as ambiguous", async () => {
    const result = await skillInstallHandler("cash-forecasting", { all: true }, dir)(ctx);
    expect(result.ok).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe("ambiguous_install");
  });

  test("missing name without --all returns missing_skill_name", async () => {
    const result = await skillInstallHandler(undefined, {}, dir)(ctx);
    expect(result.ok).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe("missing_skill_name");
  });
});
