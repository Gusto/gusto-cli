import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import onboardCompany from "../skills/onboard-company/SKILL.md" with { type: "text" };

export interface Skill {
  name: string;
  description: string;
  content: string;
}

const SKILLS: Record<string, Skill> = {
  "onboard-company": {
    name: "onboard-company",
    description: "Onboard a new Gusto company end-to-end - provision, add first hire, set up pay schedule, finalize.",
    content: onboardCompany,
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
  const file = installedPath(dir, name);
  if (!existsSync(file)) return "not_installed";
  const onDisk = await readFile(file, "utf8");
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

export function injectUserInvocable(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return markdown;
  const frontmatter = markdown.slice(4, end);
  if (/^user-invocable\s*:/m.test(frontmatter)) return markdown;
  return `---\n${frontmatter}\nuser-invocable: true\n---${markdown.slice(end + 4)}`;
}
