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

export interface SkillsDir {
  path: string;
  kind: SkillsDirKind;
  scope: "local" | "global";
}

// Single source of truth for per-tool skills dirs (fan-out, walk-up, --target, warning); only Claude reads user-invocable.
interface ToolTarget {
  readonly kind: string;
  readonly globalDir: readonly string[]; // home-relative segments of the machine-global skills dir (auto-install)
  readonly projectDir: string; // dir matched when walking up from cwd for explicit install
  readonly homeMarker: readonly string[]; // home-relative dir whose existence signals the tool is installed
  readonly injectUserInvocable: boolean; // Claude-only frontmatter augmentation
}

const TOOLS = [
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
] as const satisfies readonly ToolTarget[];

// Derived from TOOLS so the union and the registry cannot drift apart (adding a kind without a TOOLS entry is a type error).
export type SkillsDirKind = (typeof TOOLS)[number]["kind"];

const TOOL_BY_KIND = new Map<SkillsDirKind, ToolTarget>(TOOLS.map((t) => [t.kind, t]));

function toolFor(kind: SkillsDirKind): ToolTarget {
  const t = TOOL_BY_KIND.get(kind);
  if (!t) throw new Error(`no ToolTarget registered for kind: ${kind}`);
  return t;
}

// The tool kinds a --target / GUSTO_SKILLS_TARGET value may name.
export const SKILL_TARGET_KINDS: readonly SkillsDirKind[] = TOOLS.map((t) => t.kind);
const KNOWN_KINDS = new Set<string>(SKILL_TARGET_KINDS);

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

// The machine-global skills dir for one tool.
export function globalSkillsDir(kind: SkillsDirKind, home: string = homedir()): SkillsDir {
  return { path: path.join(home, ...toolFor(kind).globalDir), kind, scope: "global" };
}

// Explicit-install fallback: a human running `gusto skill install` outside any project dir.
export function globalClaudeSkillsDir(home: string = homedir()): SkillsDir {
  return globalSkillsDir("claude", home);
}

export type TargetResolution = { ok: true; dirs: SkillsDir[] } | { ok: false; invalid: string[] };

// Login auto-install fan-out: global dirs of every tool whose home dir exists (empty if none).
export function autoInstallTargets(home: string = homedir()): SkillsDir[] {
  return TOOLS.filter((t) => existsSync(path.join(home, ...t.homeMarker))).map((t) => globalSkillsDir(t.kind, home));
}

// Parse a --target/GUSTO_SKILLS_TARGET spec (comma-separated kinds, or `all`) into global dirs, bypassing detection.
export function resolveSkillTargets(spec: string, home: string = homedir()): TargetResolution {
  const tokens = spec
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, invalid: [spec] };
  // Exact Set membership (no prototype names like `constructor`); validated even with `all` so typos surface.
  const invalid = tokens.filter((t) => t !== "all" && !KNOWN_KINDS.has(t));
  if (invalid.length > 0) return { ok: false, invalid };
  if (tokens.includes("all")) {
    return { ok: true, dirs: SKILL_TARGET_KINDS.map((k) => globalSkillsDir(k, home)) };
  }
  const seen = new Set<SkillsDirKind>();
  const dirs: SkillsDir[] = [];
  for (const token of tokens as SkillsDirKind[]) {
    if (seen.has(token)) continue;
    seen.add(token);
    dirs.push(globalSkillsDir(token, home));
  }
  return { ok: true, dirs };
}

// Tool kinds + tilde home-marker labels for the no-tool warning; from the same registry detection uses.
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
  return toolFor(kind).injectUserInvocable ? injectUserInvocable(skill.content) : skill.content;
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

export interface FanOutInstall {
  results: AutoInstallResult[];
  errors: { kind: SkillsDirKind; message: string }[];
}

// Install every bundled skill into one dir conservatively (not_installed -> write, installed -> no-op, stale -> skip so local edits survive).
// Resilient per-skill: a skill that throws (symlink guard, EACCES) is captured as an error and the remaining skills still install.
export async function installBundledSkills(dir: SkillsDir = globalClaudeSkillsDir()): Promise<FanOutInstall> {
  const results: AutoInstallResult[] = [];
  const errors: FanOutInstall["errors"] = [];
  for (const skill of listSkills()) {
    try {
      const status = await getSkillStatus(skill.name, dir);
      const targetFile = installedPath(dir, skill.name);
      switch (status) {
        case "not_installed":
          await writeSkillFile(dir, targetFile, expectedContent(skill, dir.kind));
          results.push({ skill: skill.name, installedAt: targetFile, kind: dir.kind, action: "installed" });
          break;
        case "stale":
          results.push({ skill: skill.name, installedAt: targetFile, kind: dir.kind, action: "skipped_user_edited" });
          break;
        case "installed":
          results.push({ skill: skill.name, installedAt: targetFile, kind: dir.kind, action: "already_up_to_date" });
          break;
        default: {
          // Compile-time exhaustiveness guard: a new SkillStatus variant without a case is a type error.
          const _exhaustive: never = status;
          throw new Error(`unhandled SkillStatus: ${String(_exhaustive)}`);
        }
      }
    } catch (err) {
      errors.push({ kind: dir.kind, message: `${skill.name}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { results, errors };
}

// Fan out installBundledSkills across dirs and merge; resilient per-skill and per-dir.
export async function installBundledSkillsInto(dirs: SkillsDir[]): Promise<FanOutInstall> {
  const results: AutoInstallResult[] = [];
  const errors: FanOutInstall["errors"] = [];
  for (const dir of dirs) {
    const r = await installBundledSkills(dir);
    results.push(...r.results);
    errors.push(...r.errors);
  }
  return { results, errors };
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
