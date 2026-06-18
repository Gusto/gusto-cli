import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findSkillsDir,
  getSkill,
  getSkillStatus,
  injectUserInvocable,
  installBundledSkills,
  installSkill,
  listSkills,
} from "./skills.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-skills-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("listSkills + getSkill", () => {
  test("includes onboard-company", () => {
    const skills = listSkills();
    expect(skills.find((s) => s.name === "onboard-company")).toBeDefined();
  });

  test("returns null for unknown skills", () => {
    expect(getSkill("not-a-skill")).toBeNull();
  });
});

describe("injectUserInvocable", () => {
  test("inserts user-invocable: true into frontmatter", () => {
    const md = "---\nname: x\ndescription: y\n---\nbody\n";
    const result = injectUserInvocable(md);
    expect(result).toContain("user-invocable: true");
    expect(result.indexOf("user-invocable: true")).toBeLessThan(result.indexOf("---\nbody"));
  });

  test("is idempotent when user-invocable is already present", () => {
    const md = "---\nname: x\nuser-invocable: true\n---\nbody\n";
    expect(injectUserInvocable(md)).toBe(md);
  });

  test("returns input unchanged when no frontmatter", () => {
    const md = "# no frontmatter\nbody";
    expect(injectUserInvocable(md)).toBe(md);
  });
});

describe("findSkillsDir", () => {
  test("returns local .claude/skills when present", () => {
    mkdirSync(path.join(scratch, ".claude", "skills"), { recursive: true });
    const result = findSkillsDir(scratch, "/no/home");
    expect(result.kind).toBe("claude");
    expect(result.scope).toBe("local");
    expect(result.path).toBe(path.join(scratch, ".claude", "skills"));
  });

  test("returns .cursor/skills if no .claude exists", () => {
    mkdirSync(path.join(scratch, ".cursor", "skills"), { recursive: true });
    const result = findSkillsDir(scratch, "/no/home");
    expect(result.kind).toBe("cursor");
  });

  test("walks up from a nested directory", () => {
    mkdirSync(path.join(scratch, ".claude", "skills"), { recursive: true });
    const nested = path.join(scratch, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    const result = findSkillsDir(nested, "/no/home");
    expect(result.path).toBe(path.join(scratch, ".claude", "skills"));
  });

  test("falls back to ~/.claude/skills when nothing found", () => {
    const home = mkdtempSync(path.join(tmpdir(), "gusto-cli-skills-home-"));
    try {
      const result = findSkillsDir(scratch, home);
      expect(result.scope).toBe("global");
      expect(result.kind).toBe("claude");
      expect(result.path).toBe(path.join(home, ".claude", "skills"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("installSkill", () => {
  test("writes SKILL.md and injects user-invocable for .claude targets", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    const result = await installSkill("onboard-company", dir);
    expect(existsSync(result.installedAt)).toBe(true);
    const content = readFileSync(result.installedAt, "utf8");
    expect(content).toContain("user-invocable: true");
    expect(content).toContain("# Onboard a Gusto company");
    expect(result.action).toBe("installed");
  });

  test("does NOT inject user-invocable for non-claude targets", async () => {
    const dir = { path: path.join(scratch, ".cursor", "skills"), kind: "cursor" as const, scope: "local" as const };
    const result = await installSkill("onboard-company", dir);
    const content = readFileSync(result.installedAt, "utf8");
    expect(content).not.toContain("user-invocable: true");
  });

  test("returns action='refreshed' when overwriting a stale installed copy", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    const target = path.join(dir.path, "onboard-company", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "stale content from an older CLI");
    const result = await installSkill("onboard-company", dir);
    expect(result.action).toBe("refreshed");
    expect(readFileSync(result.installedAt, "utf8")).toContain("# Onboard a Gusto company");
  });

  test("returns action='already_up_to_date' when content matches", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    await installSkill("onboard-company", dir);
    const second = await installSkill("onboard-company", dir);
    expect(second.action).toBe("already_up_to_date");
  });

  test("throws on unknown skill", async () => {
    const dir = { path: scratch, kind: "claude" as const, scope: "local" as const };
    await expect(installSkill("nope", dir)).rejects.toThrow("Unknown skill");
  });
});

describe("getSkillStatus", () => {
  test("returns 'not_installed' when SKILL.md does not exist", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    expect(await getSkillStatus("onboard-company", dir)).toBe("not_installed");
  });

  test("returns 'installed' when the on-disk copy matches the bundled content", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    await installSkill("onboard-company", dir);
    expect(await getSkillStatus("onboard-company", dir)).toBe("installed");
  });

  test("returns 'stale' when the on-disk copy differs from the bundled content", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    const target = path.join(dir.path, "onboard-company", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "an older version of the skill");
    expect(await getSkillStatus("onboard-company", dir)).toBe("stale");
  });

  test("returns 'not_installed' for an unknown skill name", async () => {
    const dir = { path: scratch, kind: "claude" as const, scope: "local" as const };
    expect(await getSkillStatus("not-a-skill", dir)).toBe("not_installed");
  });
});

describe("installBundledSkills", () => {
  test("installs every bundled skill on a fresh machine", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    const results = await installBundledSkills(dir);
    expect(results.length).toBe(listSkills().length);
    for (const r of results) {
      expect(r.action).toBe("installed");
      expect(existsSync(r.installedAt)).toBe(true);
    }
  });

  test("reports already_up_to_date on second run without rewriting", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    await installBundledSkills(dir);
    const second = await installBundledSkills(dir);
    for (const r of second) expect(r.action).toBe("already_up_to_date");
  });

  test("skips stale (possibly user-edited) skills instead of clobbering them", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    const target = path.join(dir.path, "onboard-company", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    const userEdit = "user-edited content I don't want clobbered";
    writeFileSync(target, userEdit);
    const results = await installBundledSkills(dir);
    expect(results.find((r) => r.skill === "onboard-company")?.action).toBe("skipped_user_edited");
    expect(readFileSync(target, "utf8")).toBe(userEdit);
  });
});
