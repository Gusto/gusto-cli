import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import cashForecasting from "../skills/cash-forecasting/SKILL.md" with { type: "text" };
import onboardCompany from "../skills/onboard-company/SKILL.md" with { type: "text" };

export interface Skill {
  name: string;
  description: string;
  content: string;
}

/** Pull the YAML-ish frontmatter block out of a SKILL.md. Returns the body of the
 * fences (between the opening `---\n` and the closing `\n---`), or `null` if the
 * file doesn't start with frontmatter or the closing fence is missing. Shared so the
 * description parser and `injectUserInvocable` don't keep two parallel parsers that
 * could drift if the format ever evolves (CRLF, leading whitespace, etc.). */
export function extractFrontmatter(markdown: string): string | null {
  if (!markdown.startsWith("---\n")) return null;
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return null;
  return markdown.slice(4, end);
}

/** Pull the `description` field from a SKILL.md's YAML-ish frontmatter so the bundled
 * description and `gusto skill list` stay in sync with the file itself - the two used to
 * be hand-duplicated in this file and drifted. Throws if the frontmatter is malformed,
 * which is a build-time error since the .md files are baked into the binary. */
function parseSkillDescription(name: string, markdown: string): string {
  const frontmatter = extractFrontmatter(markdown);
  if (frontmatter === null) {
    throw new Error(`SKILL.md for ${name} is missing or has unterminated frontmatter`);
  }
  const match = frontmatter.match(/^description:\s*(.+)$/m);
  if (!match) throw new Error(`SKILL.md for ${name} has no description in frontmatter`);
  return match[1].trim();
}

function defineSkill(name: string, content: string): Skill {
  return { name, description: parseSkillDescription(name, content), content };
}

const SKILLS: Record<string, Skill> = {
  "onboard-company": defineSkill("onboard-company", onboardCompany),
  "cash-forecasting": defineSkill("cash-forecasting", cashForecasting),
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
    await writeSkillFile(dir, targetFile, expectedContent(skill, dir.kind));
  }

  return { skill: skill.name, installedAt: targetFile, kind: dir.kind, scope: dir.scope, action };
}

/** mkdir + writeFile, guarded against symlink-following. The skill install path can be
 * driven from a `.claude/skills` directory discovered by walking up from cwd, which means
 * an untrusted repo could plant `.claude/skills/<name>/SKILL.md` as a symlink to (e.g.)
 * `~/.ssh/authorized_keys` and trick this writer into overwriting it. After mkdir we
 * realpath the parent and verify it still resolves under the configured skills dir; then
 * lstat the target file and refuse to write through an existing symlink. */
async function writeSkillFile(dir: SkillsDir, targetFile: string, content: string): Promise<void> {
  await mkdir(path.dirname(targetFile), { recursive: true });
  const realParent = await realpath(path.dirname(targetFile));
  const realRoot = await realpath(dir.path);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
    throw new Error(
      `refusing to install skill: resolved path ${realParent} escapes the skills dir at ${realRoot} (symlink in the way?)`,
    );
  }
  try {
    const stat = await lstat(targetFile);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to install skill: ${targetFile} exists as a symlink`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await writeFile(targetFile, content);
}

/** Subset of `InstallAction` that `installBundledSkills` can actually emit, plus the
 * conservative "skipped" branch on stale files. `"refreshed"` is intentionally absent -
 * the auto-install path skips stale files so it never refreshes them. */
export type AutoInstallAction = "installed" | "already_up_to_date" | "skipped_user_edited";

export interface AutoInstallResult {
  skill: string;
  installedAt: string;
  action: AutoInstallAction;
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
    switch (status) {
      case "not_installed":
        await writeSkillFile(dir, targetFile, expectedContent(skill, dir.kind));
        out.push({ skill: skill.name, installedAt: targetFile, action: "installed" });
        break;
      case "stale":
        out.push({ skill: skill.name, installedAt: targetFile, action: "skipped_user_edited" });
        break;
      case "installed":
        out.push({ skill: skill.name, installedAt: targetFile, action: "already_up_to_date" });
        break;
      default: {
        // Compile-time exhaustiveness guard: adding a new SkillStatus variant without
        // a case here is a type error, not a silent miscategorization as up-to-date.
        const _exhaustive: never = status;
        throw new Error(`unhandled SkillStatus: ${String(_exhaustive)}`);
      }
    }
  }
  return out;
}

export function injectUserInvocable(markdown: string): string {
  const frontmatter = extractFrontmatter(markdown);
  if (frontmatter === null) return markdown;
  if (/^user-invocable\s*:/m.test(frontmatter)) return markdown;
  // We know the closing fence is at index `4 + frontmatter.length` since extractFrontmatter
  // sliced exactly that range.
  const end = 4 + frontmatter.length;
  return `---\n${frontmatter}\nuser-invocable: true\n---${markdown.slice(end + 4)}`;
}
