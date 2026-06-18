import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import cashForecasting from "../skills/cash-forecasting/SKILL.md" with { type: "text" };
import onboardCompany from "../skills/onboard-company/SKILL.md" with { type: "text" };

export interface Skill {
  name: string;
  description: string;
  content: string;
}

const SKILLS: Record<string, Skill> = {
  "onboard-company": {
    name: "onboard-company",
    description:
      "Use when the user wants to set up a new Gusto company, get a company onto payroll, or onboard their business end-to-end. Drives provisioning, tax setup, bank, pay schedule, first hire, and form signing.",
    content: onboardCompany,
  },
  "cash-forecasting": {
    name: "cash-forecasting",
    description:
      "Use when the user asks about payroll cash flow, runway, whether they can afford payroll, or how much they'll owe in upcoming pay periods. Projects payroll cash needs from history + ledger + pay-schedule cadence. Interactive and read-only.",
    content: cashForecasting,
  },
};

export function listSkills(): Skill[] {
  return Object.values(SKILLS);
}

export function getSkill(name: string): Skill | null {
  return SKILLS[name] ?? null;
}

export type SkillsDirKind = "claude" | "cursor" | "windsurf";

export interface SkillsDir {
  path: string;
  kind: SkillsDirKind;
  scope: "local" | "global";
}

const DIR_KINDS: ReadonlyArray<{ dir: string; kind: SkillsDirKind }> = [
  { dir: ".claude/skills", kind: "claude" },
  { dir: ".cursor/skills", kind: "cursor" },
  { dir: ".windsurf/skills", kind: "windsurf" },
];

export function findSkillsDir(startDir: string = process.cwd(), home: string = homedir()): SkillsDir {
  let cur = path.resolve(startDir);
  while (true) {
    for (const { dir, kind } of DIR_KINDS) {
      const candidate = path.join(cur, dir);
      if (existsSync(candidate)) return { path: candidate, kind, scope: "local" };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return globalClaudeSkillsDir(home);
}

/** Always-global Claude skills target. Used by `auth login` auto-install where the goal is
 * "any agent on this machine sees the skill" - independent of where the user happens to be
 * `cd`'d when they sign in. `findSkillsDir`'s walk-up-from-cwd is still the right shape for
 * explicit `gusto skill install`, where the user may scope to a repo on purpose. */
export function globalClaudeSkillsDir(home: string = homedir()): SkillsDir {
  return { path: path.join(home, ".claude", "skills"), kind: "claude", scope: "global" };
}

export type SkillStatus = "not_installed" | "installed" | "stale";

export type InstallAction = "installed" | "refreshed" | "already_up_to_date";

export interface InstallResult {
  skill: string;
  installedAt: string;
  kind: SkillsDirKind;
  scope: "local" | "global";
  action: InstallAction;
}

function expectedContent(skill: Skill, kind: SkillsDirKind): string {
  return kind === "claude" ? injectUserInvocable(skill.content) : skill.content;
}

function installedPath(dir: SkillsDir, name: string): string {
  return path.join(dir.path, name, "SKILL.md");
}

/** What state the installed copy of a skill is in relative to the bundled version. */
export async function getSkillStatus(name: string, dir: SkillsDir = findSkillsDir()): Promise<SkillStatus> {
  const skill = getSkill(name);
  if (!skill) return "not_installed";
  let onDisk: string;
  try {
    onDisk = await readFile(installedPath(dir, name), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "not_installed";
    throw err;
  }
  return onDisk === expectedContent(skill, dir.kind) ? "installed" : "stale";
}

const STATUS_TO_ACTION: Record<SkillStatus, InstallAction> = {
  not_installed: "installed",
  stale: "refreshed",
  installed: "already_up_to_date",
};

export async function installSkill(name: string, dir: SkillsDir = findSkillsDir()): Promise<InstallResult> {
  const skill = getSkill(name);
  if (!skill) throw new Error(`Unknown skill: ${name}`);

  const targetFile = installedPath(dir, name);
  const action = STATUS_TO_ACTION[await getSkillStatus(name, dir)];

  if (action !== "already_up_to_date") {
    await mkdir(path.dirname(targetFile), { recursive: true });
    await writeFile(targetFile, expectedContent(skill, dir.kind));
  }

  return { skill: skill.name, installedAt: targetFile, kind: dir.kind, scope: dir.scope, action };
}

export interface AutoInstallResult {
  skill: string;
  installedAt: string;
  action: InstallAction | "skipped_user_edited";
}

/** Install every bundled skill conservatively into `~/.claude/skills`:
 *
 * - not_installed -> write the file
 * - installed (already current) -> no-op
 * - stale -> skip (could be user-edited; explicit `gusto skill install --all` refreshes)
 *
 * The conservative branch on `stale` is what makes this safe to run on every `auth login`
 * without clobbering local edits. */
export async function installBundledSkills(dir: SkillsDir = globalClaudeSkillsDir()): Promise<AutoInstallResult[]> {
  const out: AutoInstallResult[] = [];
  for (const skill of listSkills()) {
    const status = await getSkillStatus(skill.name, dir);
    const targetFile = installedPath(dir, skill.name);
    if (status === "not_installed") {
      await mkdir(path.dirname(targetFile), { recursive: true });
      await writeFile(targetFile, expectedContent(skill, dir.kind));
      out.push({ skill: skill.name, installedAt: targetFile, action: "installed" });
    } else if (status === "stale") {
      out.push({ skill: skill.name, installedAt: targetFile, action: "skipped_user_edited" });
    } else {
      out.push({ skill: skill.name, installedAt: targetFile, action: "already_up_to_date" });
    }
  }
  return out;
}

export function injectUserInvocable(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return markdown;
  const frontmatter = markdown.slice(4, end);
  if (/^user-invocable\s*:/m.test(frontmatter)) return markdown;
  return `---\n${frontmatter}\nuser-invocable: true\n---${markdown.slice(end + 4)}`;
}
