import semver from "semver";

export interface ParsedCommit {
  type: string | null;
  breaking: boolean;
}

export type Bump = "patch" | "minor" | "major";

export type Recommendation = { kind: "none" } | { kind: "release"; version: string; bump: Bump };

const CONVENTIONAL_HEADER = /^(?<type>[a-z]+)(?:\([^\r\n)]*\))?(?<breaking>!)?:[ \t]+\S[^\r\n]*/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:\s/m;
const FOOTER_LINE = /^(?:BREAKING[ -]CHANGE|[A-Za-z][A-Za-z0-9-]*):\s/;
const TYPE_BUMPS: Readonly<Record<string, Exclude<Bump, "major">>> = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
  revert: "patch",
};
const BUMP_PRIORITY: Readonly<Record<Bump, number>> = { patch: 1, minor: 2, major: 3 };

function isStableVersion(version: string): boolean {
  const parsed = semver.parse(version);
  return parsed !== null && !version.startsWith("v") && parsed.prerelease.length === 0;
}

function stableVersion(version: string, label: string): string {
  if (!isStableVersion(version)) throw new Error(`${label} must be a stable semantic version`);
  return version;
}

export function parseConventionalCommit(message: string): ParsedCommit {
  const header = CONVENTIONAL_HEADER.exec(message);
  return {
    type: header?.groups?.type ?? null,
    breaking: header?.groups?.breaking === "!" || BREAKING_FOOTER.test(trailingFooterBlock(message)),
  };
}

function trailingFooterBlock(message: string): string {
  const lines = message.split(/\r?\n/);
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;

  let start = end;
  while (start > 0 && lines[start - 1] !== "") start -= 1;
  if (start === 0) return "";

  const footerLines = lines.slice(start, end);
  return footerLines.every((line) => FOOTER_LINE.test(line) || /^[ \t]/.test(line)) ? footerLines.join("\n") : "";
}

function bumpForCommit(commit: ParsedCommit): Bump | null {
  if (commit.type === null) return null;
  if (commit.breaking) return "major";
  return TYPE_BUMPS[commit.type] ?? null;
}

export function recommendRelease(currentVersion: string, messages: string[]): Recommendation {
  const current = stableVersion(currentVersion, "Current version");
  let bump: Bump | null = null;

  for (const message of messages) {
    const candidate = bumpForCommit(parseConventionalCommit(message));
    if (candidate !== null && (bump === null || BUMP_PRIORITY[candidate] > BUMP_PRIORITY[bump])) bump = candidate;
  }

  if (bump === null) return { kind: "none" };

  const effectiveBump: Bump = bump === "major" && semver.major(current) === 0 ? "minor" : bump;
  const version = semver.inc(current, effectiveBump);
  if (version === null) throw new Error(`Unable to increment current version ${current}`);
  return { kind: "release", version, bump: effectiveBump };
}

function runGit(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`git ${args[0]} failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return result.stdout.toString();
}

function greatestStableTag(): { tag: string; version: string } {
  const tags = runGit(["tag", "--list", "v*.*.*"])
    .trim()
    .split("\n")
    .filter((tag) => tag.startsWith("v"))
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .filter(({ version }) => isStableVersion(version));

  if (tags.length === 0) throw new Error("No stable v*.*.* tag exists");
  tags.sort((left, right) => semver.rcompare(left.version, right.version));
  return tags[0]!;
}

function commitMessagesSince(tag: string): string[] {
  return runGit(["log", `${tag}..HEAD`, "--format=%B%x00"])
    .split("\0")
    .map((message, index) => (index === 0 ? message : message.replace(/^\r?\n/, "")))
    .filter((message) => message !== "");
}

function explicitRecommendation(currentVersion: string, explicitVersion: string): Recommendation {
  const version = stableVersion(explicitVersion, "Explicit version");
  if (!semver.gt(version, currentVersion)) throw new Error("Explicit version must be greater than the current version");

  const bump = semver.diff(currentVersion, version);
  if (bump !== "patch" && bump !== "minor" && bump !== "major") {
    throw new Error("Explicit version must differ by a stable patch, minor, or major bump");
  }
  return { kind: "release", version, bump };
}

function parseArgs(args: string[]): { json: boolean; version: string | null } {
  let json = false;
  let version: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--version") {
      if (version !== null || index + 1 === args.length) throw new Error("--version requires one value");
      version = args[index + 1]!;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { json, version };
}

function main(): void {
  const { json, version: explicitVersion } = parseArgs(process.argv.slice(2));
  const { tag, version: currentVersion } = greatestStableTag();
  const recommendation =
    explicitVersion === null
      ? recommendRelease(currentVersion, commitMessagesSince(tag))
      : explicitRecommendation(currentVersion, explicitVersion);

  if (json) {
    console.log(JSON.stringify(recommendation));
  } else if (recommendation.kind === "none") {
    console.log("No release recommended.");
  } else {
    console.log(recommendation.version);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release-version: ${message}`);
    process.exitCode = 1;
  }
}
