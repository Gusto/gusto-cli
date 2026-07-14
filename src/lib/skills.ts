import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import cashForecasting from "../skills/cash-forecasting/SKILL.md" with { type: "text" };
import payrollPrep from "../skills/payroll-prep/SKILL.md" with { type: "text" };
import timesheetSync from "../skills/timesheet-sync/SKILL.md" with { type: "text" };

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
  "cash-forecasting": defineSkill("cash-forecasting", cashForecasting),
  "payroll-prep": defineSkill("payroll-prep", payrollPrep),
  "timesheet-sync": defineSkill("timesheet-sync", timesheetSync),
};

export function listSkills(): Skill[] {
  return Object.values(SKILLS);
}

export function getSkill(name: string): Skill | null {
  return SKILLS[name] ?? null;
}

export type SkillsDirKind = "claude" | "cursor" | "codex" | "cline" | "windsurf";

export interface SkillsDir {
  path: string;
  kind: SkillsDirKind;
  scope: "local" | "global";
}

/** One entry per agent tool we know how to install skills for. Single source of truth so the
 * auto-install fan-out, the walk-up for explicit `gusto skill install`, the `--target` override,
 * and the "no tool detected" warning all stay in agreement. All five tools read the same
 * `SKILL.md` format; only Claude recognizes the `user-invocable` frontmatter line. */
interface ToolTarget {
  kind: SkillsDirKind;
  /** Path segments under the home dir for the machine-global skills dir (auto-install target). */
  globalDir: string[];
  /** Directory (relative to a repo dir) matched when walking up from cwd for explicit install. */
  projectDir: string;
  /** Path segments under the home dir whose existence signals the tool is installed on this box. */
  homeMarker: string[];
  /** Claude-only: augment the installed SKILL.md frontmatter with `user-invocable: true`. */
  injectUserInvocable: boolean;
}

const TOOLS: readonly ToolTarget[] = [
  {
    kind: "claude",
    globalDir: [".claude", "skills"],
    projectDir: ".claude/skills",
    homeMarker: [".claude"],
    injectUserInvocable: true,
  },
  {
    kind: "cursor",
    globalDir: [".cursor", "skills"],
    projectDir: ".cursor/skills",
    homeMarker: [".cursor"],
    injectUserInvocable: false,
  },
  {
    kind: "codex",
    globalDir: [".codex", "skills"],
    projectDir: ".agents/skills",
    homeMarker: [".codex"],
    injectUserInvocable: false,
  },
  {
    kind: "cline",
    globalDir: [".cline", "skills"],
    projectDir: ".cline/skills",
    homeMarker: [".cline"],
    injectUserInvocable: false,
  },
  {
    kind: "windsurf",
    globalDir: [".codeium", "windsurf", "skills"],
    projectDir: ".windsurf/skills",
    homeMarker: [".codeium"],
    injectUserInvocable: false,
  },
];

const TOOL_BY_KIND = Object.fromEntries(TOOLS.map((t) => [t.kind, t])) as Record<SkillsDirKind, ToolTarget>;

/** The tool kinds a `--target` / GUSTO_SKILLS_TARGET value may name. */
export const SKILL_TARGET_KINDS: readonly SkillsDirKind[] = TOOLS.map((t) => t.kind);

export function findSkillsDir(startDir: string = process.cwd(), home: string = homedir()): SkillsDir {
  let cur = path.resolve(startDir);
  while (true) {
    for (const tool of TOOLS) {
      const candidate = path.join(cur, tool.projectDir);
      if (existsSync(candidate)) return { path: candidate, kind: tool.kind, scope: "local" };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return globalClaudeSkillsDir(home);
}

/** The machine-global skills dir for one tool. */
export function globalSkillsDir(kind: SkillsDirKind, home: string = homedir()): SkillsDir {
  return { path: path.join(home, ...TOOL_BY_KIND[kind].globalDir), kind, scope: "global" };
}

/** Always-global Claude skills target, kept as the explicit-install fallback (a human who runs
 * `gusto skill install` outside any project dir still gets a sensible default). */
export function globalClaudeSkillsDir(home: string = homedir()): SkillsDir {
  return globalSkillsDir("claude", home);
}

/** Global skills dirs for every supported tool detected on this machine, keyed on the tool's home
 * dir existing (not its skills subdir, so a freshly installed tool still gets ours). Empty when no
 * supported tool is present. This is the login auto-install fan-out: "any agent on this machine
 * sees the skill", independent of where the user was `cd`'d at sign-in. */
export function autoInstallTargets(home: string = homedir()): SkillsDir[] {
  return TOOLS.filter((t) => existsSync(path.join(home, ...t.homeMarker))).map((t) => globalSkillsDir(t.kind, home));
}

export type TargetResolution = { ok: true; dirs: SkillsDir[] } | { ok: false; invalid: string[] };

/** Parse a `--target` / GUSTO_SKILLS_TARGET spec (comma-separated tool kinds, or the literal `all`)
 * into global skills dirs. Unlike `autoInstallTargets`, an explicit target bypasses presence
 * detection and installs exactly where the user asks, creating the dir as needed. Returns the
 * unrecognized tokens on failure so the caller can surface a structured retry. */
export function resolveSkillTargets(spec: string, home: string = homedir()): TargetResolution {
  const tokens = spec
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, invalid: [spec] };
  if (tokens.includes("all")) {
    return { ok: true, dirs: SKILL_TARGET_KINDS.map((k) => globalSkillsDir(k, home)) };
  }
  const invalid = tokens.filter((t) => !(t in TOOL_BY_KIND));
  if (invalid.length > 0) return { ok: false, invalid };
  const seen = new Set<SkillsDirKind>();
  const dirs: SkillsDir[] = [];
  for (const token of tokens as SkillsDirKind[]) {
    if (seen.has(token)) continue;
    seen.add(token);
    dirs.push(globalSkillsDir(token, home));
  }
  return { ok: true, dirs };
}

/** Tool kinds and their home-marker paths in tilde form, for the "no supported tool detected"
 * warning. Built from the same registry `autoInstallTargets` probes, so the message cannot drift
 * from what detection actually checks. */
export function supportedToolHomeLabels(): { kind: SkillsDirKind; label: string }[] {
  return TOOLS.map((t) => ({ kind: t.kind, label: path.join("~", ...t.homeMarker) }));
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
  return TOOL_BY_KIND[kind].injectUserInvocable ? injectUserInvocable(skill.content) : skill.content;
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
  kind: SkillsDirKind;
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
        out.push({ skill: skill.name, installedAt: targetFile, kind: dir.kind, action: "installed" });
        break;
      case "stale":
        out.push({ skill: skill.name, installedAt: targetFile, kind: dir.kind, action: "skipped_user_edited" });
        break;
      case "installed":
        out.push({ skill: skill.name, installedAt: targetFile, kind: dir.kind, action: "already_up_to_date" });
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

/** Install every bundled skill into each of the given dirs and flatten the results. This is the
 * login auto-install fan-out: a machine running two agent tools gets skills in both. Each dir is
 * installed conservatively (see `installBundledSkills`); a symlink escape in any dir throws. */
export async function installBundledSkillsInto(dirs: SkillsDir[]): Promise<AutoInstallResult[]> {
  const out: AutoInstallResult[] = [];
  for (const dir of dirs) {
    out.push(...(await installBundledSkills(dir)));
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
