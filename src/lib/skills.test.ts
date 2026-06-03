import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findSkillsDir, getSkill, injectUserInvocable, installSkill, listSkills } from "./skills.ts";

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
  });

  test("does NOT inject user-invocable for non-claude targets", async () => {
    const dir = { path: path.join(scratch, ".cursor", "skills"), kind: "cursor" as const, scope: "local" as const };
    const result = await installSkill("onboard-company", dir);
    const content = readFileSync(result.installedAt, "utf8");
    expect(content).not.toContain("user-invocable: true");
  });

  test("throws on unknown skill", async () => {
    const dir = { path: scratch, kind: "claude" as const, scope: "local" as const };
    await expect(installSkill("nope", dir)).rejects.toThrow("Unknown skill");
  });
});
