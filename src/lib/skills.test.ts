import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  autoInstallTargets,
  findSkillsDir,
  getSkill,
  getSkillStatus,
  globalSkillsDir,
  injectUserInvocable,
  installBundledSkills,
  installBundledSkillsInto,
  installSkill,
  listSkills,
  resolveSkillTargets,
  supportedToolHomeLabels,
} from "./skills.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-skills-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("skill description", () => {
  test("is sourced from the SKILL.md frontmatter (no hand-duplicated drift)", () => {
    // Cover every bundled skill so a newly added one can't silently skip this invariant.
    const skills = listSkills();
    // Guard against a vacuous pass: if skill discovery breaks and returns nothing, the
    // loop below would assert nothing and still go green.
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      // The description must literally appear in the bundled SKILL.md content; that's
      // the invariant a regression-by-drift would break.
      expect(skill.content).toContain(skill.description);
      expect(skill.content).toContain(`description: ${skill.description}`);
    }
  });
});

describe("listSkills + getSkill", () => {
  test("includes cash-forecasting", () => {
    const skills = listSkills();
    expect(skills.find((s) => s.name === "cash-forecasting")).toBeDefined();
  });

  test("includes payroll-prep", () => {
    const skills = listSkills();
    expect(skills.find((s) => s.name === "payroll-prep")).toBeDefined();
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
    const result = await installSkill("cash-forecasting", dir);
    expect(existsSync(result.installedAt)).toBe(true);
    const content = readFileSync(result.installedAt, "utf8");
    expect(content).toContain("user-invocable: true");
    expect(content).toContain("# Forecast payroll cash needs");
    expect(result.action).toBe("installed");
  });

  test("does NOT inject user-invocable for non-claude targets", async () => {
    const dir = { path: path.join(scratch, ".cursor", "skills"), kind: "cursor" as const, scope: "local" as const };
    const result = await installSkill("cash-forecasting", dir);
    const content = readFileSync(result.installedAt, "utf8");
    expect(content).not.toContain("user-invocable: true");
  });

  test("returns action='refreshed' when overwriting a stale installed copy", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    const target = path.join(dir.path, "cash-forecasting", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "stale content from an older CLI");
    const result = await installSkill("cash-forecasting", dir);
    expect(result.action).toBe("refreshed");
    expect(readFileSync(result.installedAt, "utf8")).toContain("# Forecast payroll cash needs");
  });

  test("returns action='already_up_to_date' when content matches", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    await installSkill("cash-forecasting", dir);
    const second = await installSkill("cash-forecasting", dir);
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
    expect(await getSkillStatus("cash-forecasting", dir)).toBe("not_installed");
  });

  test("returns 'installed' when the on-disk copy matches the bundled content", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    await installSkill("cash-forecasting", dir);
    expect(await getSkillStatus("cash-forecasting", dir)).toBe("installed");
  });

  test("returns 'stale' when the on-disk copy differs from the bundled content", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    const target = path.join(dir.path, "cash-forecasting", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "an older version of the skill");
    expect(await getSkillStatus("cash-forecasting", dir)).toBe("stale");
  });

  test("returns 'not_installed' for an unknown skill name", async () => {
    const dir = { path: scratch, kind: "claude" as const, scope: "local" as const };
    expect(await getSkillStatus("not-a-skill", dir)).toBe("not_installed");
  });
});

describe("symlink-follow guard", () => {
  test("installSkill refuses to write through a symlink at the target file", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    const skillDir = path.join(dir.path, "cash-forecasting");
    mkdirSync(skillDir, { recursive: true });
    // Plant a symlink where SKILL.md should land - simulating an attacker who controls
    // the discovered .claude/skills tree (e.g. a malicious repo). The installer must
    // refuse rather than overwrite the symlink target.
    const decoy = path.join(scratch, "sensitive-target.txt");
    writeFileSync(decoy, "original content");
    symlinkSync(decoy, path.join(skillDir, "SKILL.md"));
    await expect(installSkill("cash-forecasting", dir)).rejects.toThrow(/symlink/);
    expect(readFileSync(decoy, "utf8")).toBe("original content");
  });

  test("installSkill refuses when the parent dir resolves outside the skills root", async () => {
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "local" as const };
    // .claude/skills/cash-forecasting points at /tmp/<scratch>/elsewhere via symlink.
    const elsewhere = path.join(scratch, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(dir.path, { recursive: true });
    symlinkSync(elsewhere, path.join(dir.path, "cash-forecasting"));
    await expect(installSkill("cash-forecasting", dir)).rejects.toThrow(/escapes the skills dir/);
    expect(existsSync(path.join(elsewhere, "SKILL.md"))).toBe(false);
  });

  test("installBundledSkills refuses when the skill dir is a symlink to elsewhere", async () => {
    // A pre-existing SKILL.md symlink would naturally land in the conservative "stale"
    // branch (readFile through the symlink doesn't match bundled content, so it's
    // skipped). The unsafe path is a *directory*-level symlink where SKILL.md doesn't
    // yet exist - mkdir+writeFile would otherwise follow the symlink and create the
    // file at the wrong path.
    const dir = { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "global" as const };
    const elsewhere = path.join(scratch, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(dir.path, { recursive: true });
    symlinkSync(elsewhere, path.join(dir.path, "cash-forecasting"));
    await expect(installBundledSkills(dir)).rejects.toThrow(/escapes the skills dir/);
    expect(existsSync(path.join(elsewhere, "SKILL.md"))).toBe(false);
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
    const target = path.join(dir.path, "cash-forecasting", "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    const userEdit = "user-edited content I don't want clobbered";
    writeFileSync(target, userEdit);
    const results = await installBundledSkills(dir);
    expect(results.find((r) => r.skill === "cash-forecasting")?.action).toBe("skipped_user_edited");
    expect(readFileSync(target, "utf8")).toBe(userEdit);
  });

  test("tags each result with the tool kind it installed into", async () => {
    const dir = { path: path.join(scratch, ".cursor", "skills"), kind: "cursor" as const, scope: "global" as const };
    const results = await installBundledSkills(dir);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.kind).toBe("cursor");
  });
});

describe("globalSkillsDir", () => {
  test("maps each supported tool kind to its native global skills dir", () => {
    const home = "/home/u";
    expect(globalSkillsDir("claude", home).path).toBe(path.join(home, ".claude", "skills"));
    expect(globalSkillsDir("cursor", home).path).toBe(path.join(home, ".cursor", "skills"));
    expect(globalSkillsDir("codex", home).path).toBe(path.join(home, ".codex", "skills"));
    expect(globalSkillsDir("cline", home).path).toBe(path.join(home, ".cline", "skills"));
    expect(globalSkillsDir("windsurf", home).path).toBe(path.join(home, ".codeium", "windsurf", "skills"));
  });

  test("carries the kind and global scope", () => {
    const dir = globalSkillsDir("codex", "/home/u");
    expect(dir.kind).toBe("codex");
    expect(dir.scope).toBe("global");
  });
});

describe("autoInstallTargets", () => {
  // Presence is keyed on the tool's home directory existing, not its skills subdir,
  // so a freshly installed tool that hasn't created a skills dir yet still gets ours.
  const mark = (home: string, ...dirs: string[]) => {
    for (const d of dirs) mkdirSync(path.join(home, d), { recursive: true });
  };

  test("returns nothing when no supported tool is present", () => {
    expect(autoInstallTargets(scratch)).toEqual([]);
  });

  test("returns only the present tool's global dir", () => {
    mark(scratch, ".cursor");
    const targets = autoInstallTargets(scratch);
    expect(targets.map((d) => d.kind)).toEqual(["cursor"]);
    expect(targets[0].path).toBe(path.join(scratch, ".cursor", "skills"));
  });

  test("fans out to every present tool", () => {
    mark(scratch, ".claude", ".codex", ".codeium");
    const kinds = autoInstallTargets(scratch)
      .map((d) => d.kind)
      .sort();
    expect(kinds).toEqual(["claude", "codex", "windsurf"]);
  });
});

describe("resolveSkillTargets", () => {
  test("resolves a single kind to its global dir", () => {
    const res = resolveSkillTargets("cursor", "/home/u");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.dirs.map((d) => d.kind)).toEqual(["cursor"]);
    expect(res.dirs[0].path).toBe(path.join("/home/u", ".cursor", "skills"));
  });

  test("resolves a comma list, trims, and dedups", () => {
    const res = resolveSkillTargets(" claude , cursor , claude ", "/home/u");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.dirs.map((d) => d.kind)).toEqual(["claude", "cursor"]);
  });

  test("'all' expands to every supported tool", () => {
    const res = resolveSkillTargets("all", "/home/u");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.dirs.map((d) => d.kind).sort()).toEqual(["claude", "cline", "codex", "cursor", "windsurf"]);
  });

  test("reports unknown kinds and does not resolve", () => {
    const res = resolveSkillTargets("cursor,emacs,vim", "/home/u");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.invalid).toEqual(["emacs", "vim"]);
  });

  test("an empty spec is invalid", () => {
    const res = resolveSkillTargets("   ", "/home/u");
    expect(res.ok).toBe(false);
  });
});

describe("supportedToolHomeLabels", () => {
  test("lists every supported tool with a tilde home-marker label, from the same registry detection uses", () => {
    const labels = supportedToolHomeLabels();
    expect(labels.map((l) => l.kind).sort()).toEqual(["claude", "cline", "codex", "cursor", "windsurf"]);
    const byKind = Object.fromEntries(labels.map((l) => [l.kind, l.label]));
    expect(byKind.claude).toBe("~/.claude");
    expect(byKind.windsurf).toBe("~/.codeium");
  });
});

describe("installBundledSkillsInto", () => {
  test("fans out every bundled skill into each given dir", async () => {
    const dirs = [
      { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "global" as const },
      { path: path.join(scratch, ".cursor", "skills"), kind: "cursor" as const, scope: "global" as const },
    ];
    const results = await installBundledSkillsInto(dirs);
    expect(results.length).toBe(listSkills().length * 2);
    expect(results.filter((r) => r.kind === "claude").length).toBe(listSkills().length);
    expect(results.filter((r) => r.kind === "cursor").length).toBe(listSkills().length);
    for (const r of results) expect(existsSync(r.installedAt)).toBe(true);
  });

  test("injects user-invocable only into the claude copy, not the cursor copy", async () => {
    const dirs = [
      { path: path.join(scratch, ".claude", "skills"), kind: "claude" as const, scope: "global" as const },
      { path: path.join(scratch, ".cursor", "skills"), kind: "cursor" as const, scope: "global" as const },
    ];
    await installBundledSkillsInto(dirs);
    const claudeCopy = readFileSync(path.join(scratch, ".claude", "skills", "cash-forecasting", "SKILL.md"), "utf8");
    const cursorCopy = readFileSync(path.join(scratch, ".cursor", "skills", "cash-forecasting", "SKILL.md"), "utf8");
    expect(claudeCopy).toContain("user-invocable: true");
    expect(cursorCopy).not.toContain("user-invocable: true");
  });

  test("returns an empty array when given no dirs", async () => {
    expect(await installBundledSkillsInto([])).toEqual([]);
  });
});

describe("findSkillsDir - added tool kinds", () => {
  test("recognizes Codex project skills at .agents/skills", () => {
    mkdirSync(path.join(scratch, ".agents", "skills"), { recursive: true });
    const result = findSkillsDir(scratch, "/no/home");
    expect(result.kind).toBe("codex");
    expect(result.scope).toBe("local");
  });

  test("recognizes Cline project skills at .cline/skills", () => {
    mkdirSync(path.join(scratch, ".cline", "skills"), { recursive: true });
    const result = findSkillsDir(scratch, "/no/home");
    expect(result.kind).toBe("cline");
  });
});
