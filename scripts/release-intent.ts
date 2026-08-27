import { createHash } from "node:crypto";
import path from "node:path";
import semver from "semver";

export type ReleaseIntentResult =
  | { kind: "none" }
  | {
      kind: "release";
      version: string;
      commitSha: string;
      previousTag: string;
      releaseNotesSha256: string;
    };

export interface RefreshIntentResult {
  kind: "refresh";
  version: string;
  commitSha: string;
  previousTag: string;
  releaseNotesSha256: string;
}

export type RefreshContext = "post-merge" | "pr";

interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface PackageManifest {
  version: string;
  repository: string | { url?: string };
  [key: string]: unknown;
}

interface ChangelogHeading {
  index: number;
  version: string;
  link: string | null;
}

interface ParsedChangelog {
  markdown: string;
  headings: ChangelogHeading[];
}

interface ParsedIntentArgs {
  base: string;
  head: string;
  json: boolean;
  version?: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const FULL_SHA = /^[0-9a-f]{40}$/;
const RELEASE_ATTEMPT = /^chore: release(?:\s|$)/;

function run(repo: string, command: string[], allowFailure = false): CommandResult {
  const result = Bun.spawnSync(command, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const normalized = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  if (!allowFailure && result.exitCode !== 0) {
    const detail = decodeOutput(result.stderr).trim() || decodeOutput(result.stdout).trim();
    throw new Error(`${command[0]} ${command[1] ?? ""} failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return normalized;
}

function decodeOutput(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error("Command output was not UTF-8 text");
  }
}

function git(repo: string, args: string[], allowFailure = false): CommandResult {
  return run(repo, ["git", ...args], allowFailure);
}

function gitText(repo: string, args: string[]): string {
  return decodeOutput(git(repo, args).stdout).trimEnd();
}

function resolveCommit(repo: string, value: string, label: string): string {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
  const resolved = gitText(repo, ["rev-parse", "--verify", `${value}^{commit}`]);
  if (resolved !== value) throw new Error(`${label} did not resolve to the supplied commit SHA`);
  return resolved;
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  const result = git(repo, ["merge-base", "--is-ancestor", ancestor, descendant], true);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("Could not verify commit ancestry");
}

function assertFirstParentDescendant(repo: string, base: string, head: string): void {
  const commits = gitText(repo, ["rev-list", "--first-parent", head]).split("\n");
  if (!commits.includes(base)) throw new Error("Head must be a first-parent descendant of base");
}

function assertDescendant(repo: string, base: string, head: string): void {
  if (!isAncestor(repo, base, head)) throw new Error("Head must be a descendant of base");
}

function assertRefreshContext(repo: string, head: string, context: RefreshContext): void {
  if (context === "pr") return;

  const remote = git(repo, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"], true);
  if (remote.exitCode === 0) {
    if (isAncestor(repo, head, decodeOutput(remote.stdout).trim())) return;
    throw new Error("Refresh head must be reachable from origin/main");
  }
  if (remote.exitCode !== 1) throw new Error("Could not resolve refs/remotes/origin/main");

  const local = git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"], true);
  if (local.exitCode === 0) {
    if (isAncestor(repo, head, decodeOutput(local.stdout).trim())) return;
    throw new Error("Refresh head must be reachable from main");
  }
  if (local.exitCode !== 1) throw new Error("Could not resolve refs/heads/main");
  throw new Error("Could not resolve origin/main or main");
}

function readBlob(repo: string, sha: string, file: string): Uint8Array {
  const result = git(repo, ["show", `${sha}:${file}`], true);
  if (result.exitCode !== 0) throw new Error(`Could not read ${file} at ${sha}`);
  return result.stdout;
}

function strictText(bytes: Uint8Array, label: string): string {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error(`${label} must be UTF-8 text`);
  }
  if (text.includes("\0")) throw new Error(`${label} must be UTF-8 text without NUL bytes`);
  if (text.includes("\r")) throw new Error(`${label} must use LF text without CRLF bytes`);
  return text;
}

function parseManifest(repo: string, sha: string): PackageManifest {
  const source = strictText(readBlob(repo, sha, "package.json"), "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("package.json must contain valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json JSON must be an object");
  }
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.version !== "string") throw new Error("package.json version must be a string");
  if (
    typeof manifest.repository !== "string" &&
    !(
      typeof manifest.repository === "object" &&
      manifest.repository !== null &&
      !Array.isArray(manifest.repository) &&
      (manifest.repository as Record<string, unknown>).url !== undefined
    )
  ) {
    throw new Error("package.json repository is required");
  }
  return manifest as PackageManifest;
}

function normalizedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${normalizedJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutVersion(manifest: PackageManifest): Record<string, unknown> {
  const { version: _version, ...result } = manifest;
  return result;
}

function stableVersion(version: string, label: string): string {
  const parsed = semver.parse(version);
  if (parsed === null || version.startsWith("v") || parsed.prerelease.length > 0) {
    throw new Error(`${label} must be a stable semantic version`);
  }
  return version;
}

function commitSubject(repo: string, head: string): string {
  const commit = strictText(git(repo, ["cat-file", "commit", head]).stdout, "Commit object");
  const messageIndex = commit.indexOf("\n\n");
  if (messageIndex < 0) throw new Error("Could not read the exact commit subject");
  const message = commit.slice(messageIndex + 2);
  return message.slice(0, message.indexOf("\n") < 0 ? message.length : message.indexOf("\n"));
}

function changedPaths(repo: string, base: string, head: string): Array<{ status: string; paths: string[] }> {
  const raw = git(repo, ["diff", "--name-status", "-z", "--find-renames", base, head, "--"]).stdout;
  const fields = decodeOutput(raw).split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes: Array<{ status: string; paths: string[] }> = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (status === undefined || status === "") throw new Error("Malformed git diff output");
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const paths = fields.slice(index, index + pathCount);
    if (paths.length !== pathCount) throw new Error("Malformed git diff output");
    changes.push({ status, paths });
    index += pathCount;
  }
  return changes;
}

function assertExactModifiedPaths(repo: string, base: string, head: string, expected: string[], message: string): void {
  const changes = changedPaths(repo, base, head);
  const actual = changes.flatMap((change) => change.paths).sort();
  if (
    changes.some((change) => change.status !== "M") ||
    actual.length !== expected.length ||
    actual.some((file, index) => file !== [...expected].sort()[index])
  ) {
    throw new Error(message);
  }
}

function parseChangelog(markdown: string): ParsedChangelog {
  if (markdown.includes("\r")) throw new Error("CHANGELOG.md must use LF text without CRLF bytes");
  if (markdown.includes("\0")) throw new Error("CHANGELOG.md must be UTF-8 text without NUL bytes");
  if (markdown !== "# Changelog\n" && !markdown.startsWith("# Changelog\n\n")) {
    throw new Error("CHANGELOG.md must start with the exact # Changelog header");
  }
  const headings = [...markdown.matchAll(/^## \[([^\]\n]+)\](?:\(([^)\n]+)\))?[^\n]*$/gm)].map((match) => ({
    index: match.index,
    version: match[1]!,
    link: match[2] ?? null,
  }));
  const topLevelHeadingCount = markdown.match(/^## /gm)?.length ?? 0;
  if (topLevelHeadingCount !== headings.length) throw new Error("Malformed changelog heading");
  if (headings.length > 0 && headings[0]!.index !== "# Changelog\n\n".length) {
    throw new Error("The first changelog section must immediately follow the title");
  }
  return { markdown, headings };
}

function changelogAt(repo: string, sha: string): ParsedChangelog {
  return parseChangelog(strictText(readBlob(repo, sha, "CHANGELOG.md"), "CHANGELOG.md"));
}

function sectionBytes(changelog: ParsedChangelog, index: number): string {
  const heading = changelog.headings[index];
  if (heading === undefined) throw new Error("Missing changelog section");
  const end = changelog.headings[index + 1]?.index ?? changelog.markdown.length;
  return `${changelog.markdown.slice(heading.index, end).replace(/\n+$/, "")}\n`;
}

function repositoryBase(manifest: PackageManifest): string {
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository.url;
  if (typeof repository !== "string") throw new Error("package.json repository URL is required");
  const normalized = repository.replace(/^git\+/, "").replace(/\.git$/, "");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("package.json repository must be a public GitHub HTTPS URL");
  }
  return normalized;
}

function assertTargetTagAbsent(repo: string, version: string): void {
  const tag = `v${version}`;
  const lookup = git(repo, ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], true);
  if (lookup.exitCode === 0) throw new Error(`Tag ${tag} already exists`);
  if (lookup.exitCode !== 1) throw new Error(`Could not verify whether tag ${tag} exists`);
}

function previousStableTag(repo: string, base: string, targetVersion: string): string {
  const candidates = gitText(repo, ["tag", "--list", "v*.*.*"])
    .split("\n")
    .filter(Boolean)
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .filter(({ version }) => {
      const parsed = semver.parse(version);
      return parsed !== null && parsed.prerelease.length === 0;
    })
    .sort((left, right) => semver.rcompare(left.version, right.version));
  const previous = candidates[0];
  if (previous === undefined) throw new Error("No previous stable tag exists");
  if (!semver.gt(targetVersion, previous.version)) {
    throw new Error(`Release version ${targetVersion} must be greater than previous stable tag ${previous.tag}`);
  }
  const tagCommit = gitText(repo, ["rev-parse", "--verify", `${previous.tag}^{commit}`]);
  assertFirstParentDescendant(repo, tagCommit, base);
  return previous.tag;
}

function expectedComparisonLink(manifest: PackageManifest, previousTag: string, version: string): string {
  return `${repositoryBase(manifest)}/compare/${previousTag}...v${version}`;
}

function assertLeadingSection(changelog: ParsedChangelog, version: string, comparisonLink: string): ChangelogHeading {
  const leading = changelog.headings[0];
  if (leading === undefined || leading.version !== version) {
    throw new Error(`The leading changelog section must be ${version}`);
  }
  if (leading.link !== comparisonLink)
    throw new Error(`The leading changelog section must use comparison link ${comparisonLink}`);
  return leading;
}

function hashNotes(notes: string): string {
  return createHash("sha256").update(notes).digest("hex");
}

export function extractChangelogSection(markdown: string, version: string): string {
  stableVersion(version, "Changelog version");
  const parsed = parseChangelog(markdown);
  const matching = parsed.headings
    .map((heading, index) => ({ heading, index }))
    .filter(({ heading }) => heading.version === version);
  if (matching.length !== 1) throw new Error(`Expected exactly one changelog section ${version}`);
  return sectionBytes(parsed, matching[0]!.index);
}

export function inspectReleaseIntent(repo: string, baseValue: string, headValue: string): ReleaseIntentResult {
  const base = resolveCommit(repo, baseValue, "Base");
  const head = resolveCommit(repo, headValue, "Head");
  assertFirstParentDescendant(repo, base, head);

  const baseManifest = parseManifest(repo, base);
  const headManifest = parseManifest(repo, head);
  const subject = commitSubject(repo, head);
  if (baseManifest.version === headManifest.version) {
    if (RELEASE_ATTEMPT.test(subject)) throw new Error("Release-shaped commit did not change package.json version");
    return { kind: "none" };
  }

  const baseVersion = stableVersion(baseManifest.version, "Base package version");
  const version = stableVersion(headManifest.version, "Release version");
  if (!semver.gt(version, baseVersion)) throw new Error(`Release version must be greater than ${baseVersion}`);
  if (normalizedJson(withoutVersion(baseManifest)) !== normalizedJson(withoutVersion(headManifest))) {
    throw new Error("A release may change only package.json version");
  }
  if (subject !== `chore: release ${version}`) {
    throw new Error(`Release commit subject must be exactly chore: release ${version}`);
  }
  assertExactModifiedPaths(
    repo,
    base,
    head,
    ["CHANGELOG.md", "package.json"],
    "Release modified paths must be exactly CHANGELOG.md and package.json with no renames",
  );
  assertTargetTagAbsent(repo, version);
  const previousTag = previousStableTag(repo, base, version);
  const comparisonLink = expectedComparisonLink(headManifest, previousTag, version);
  const before = changelogAt(repo, base);
  const after = changelogAt(repo, head);
  assertLeadingSection(after, version, comparisonLink);

  if (before.headings.length === 0) {
    if (baseVersion !== "0.2.0" || version !== "0.3.0" || before.markdown !== "# Changelog\n") {
      throw new Error("A header-only bootstrap is allowed only for the reviewed 0.2.0 to 0.3.0 release");
    }
    if (after.headings.length !== 1) throw new Error("The bootstrap must add exactly one leading changelog section");
  } else {
    if (after.headings.length !== before.headings.length + 1) {
      throw new Error("A release must add exactly one leading changelog section");
    }
    const beforeHistory = before.markdown.slice(before.headings[0]!.index);
    const afterHistory = after.markdown.slice(after.headings[1]!.index);
    if (afterHistory !== beforeHistory) throw new Error("A release must preserve historical changelog bytes");
  }

  const notes = sectionBytes(after, 0);
  return { kind: "release", version, commitSha: head, previousTag, releaseNotesSha256: hashNotes(notes) };
}

export function inspectRefreshIntent(
  repo: string,
  baseValue: string,
  headValue: string,
  requestedVersion: string,
  context: RefreshContext = "post-merge",
): RefreshIntentResult {
  if (context !== "post-merge" && context !== "pr") throw new Error(`Unknown refresh context: ${String(context)}`);
  const base = resolveCommit(repo, baseValue, "Base");
  const head = resolveCommit(repo, headValue, "Head");
  assertDescendant(repo, base, head);
  assertRefreshContext(repo, head, context);

  const beforeManifest = parseManifest(repo, base);
  const afterManifest = parseManifest(repo, head);
  const version = stableVersion(requestedVersion, "Refresh version");
  if (beforeManifest.version !== afterManifest.version)
    throw new Error("A refresh must not change package.json version");
  if (version !== afterManifest.version) {
    throw new Error(`Refresh version ${version} must equal package.json version ${afterManifest.version}`);
  }
  if (commitSubject(repo, head) !== `chore: refresh release ${version}`) {
    throw new Error(`Refresh commit subject must be exactly chore: refresh release ${version}`);
  }
  assertExactModifiedPaths(
    repo,
    base,
    head,
    ["CHANGELOG.md"],
    "A refresh must modify exactly CHANGELOG.md with no renames",
  );
  assertTargetTagAbsent(repo, version);
  const previousTag = previousStableTag(repo, base, version);
  const comparisonLink = expectedComparisonLink(afterManifest, previousTag, version);
  const before = changelogAt(repo, base);
  const after = changelogAt(repo, head);
  assertLeadingSection(before, version, comparisonLink);
  assertLeadingSection(after, version, comparisonLink);
  if (before.headings.length !== after.headings.length || before.headings.length === 0) {
    throw new Error("A refresh must retain the existing leading changelog section structure");
  }
  const beforeHistory = before.markdown.slice(before.headings[1]?.index ?? before.markdown.length);
  const afterHistory = after.markdown.slice(after.headings[1]?.index ?? after.markdown.length);
  if (afterHistory !== beforeHistory) throw new Error("A refresh must preserve historical changelog bytes");
  const beforeNotes = sectionBytes(before, 0);
  const afterNotes = sectionBytes(after, 0);
  if (beforeNotes === afterNotes) throw new Error("A refresh must materially change the leading changelog section");
  return { kind: "refresh", version, commitSha: head, previousTag, releaseNotesSha256: hashNotes(afterNotes) };
}

function parseNamedArgs(args: string[], mode: "push" | "refresh"): ParsedIntentArgs {
  let base: string | undefined;
  let head: string | undefined;
  let version: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      if (json) throw new Error("--json may be provided only once");
      json = true;
      continue;
    }
    if (arg !== "--base" && arg !== "--head" && arg !== "--version") throw new Error(`Unknown argument: ${arg ?? ""}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires one value`);
    index += 1;
    if (arg === "--base") {
      if (base !== undefined) throw new Error("--base may be provided only once");
      base = value;
    } else if (arg === "--head") {
      if (head !== undefined) throw new Error("--head may be provided only once");
      head = value;
    } else {
      if (version !== undefined) throw new Error("--version may be provided only once");
      version = value;
    }
  }
  if (base === undefined || head === undefined) throw new Error(`${mode} requires --base and --head`);
  if (mode === "refresh" && version === undefined) throw new Error("refresh requires --version");
  if (mode === "push" && version !== undefined) throw new Error("push does not accept --version");
  return { base, head, json, ...(version === undefined ? {} : { version }) };
}

function refreshContextFromEnvironment(): RefreshContext {
  const value = process.env.RELEASE_INTENT_CONTEXT;
  if (value === undefined || value === "") return "post-merge";
  if (value === "pr") return "pr";
  throw new Error(`Unknown RELEASE_INTENT_CONTEXT: ${value}`);
}

function parseExtractArgs(args: string[]): { sha: string; version: string; output: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--sha" && arg !== "--version" && arg !== "--output") throw new Error(`Unknown argument: ${arg ?? ""}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires one value`);
    if (values.has(arg)) throw new Error(`${arg} may be provided only once`);
    values.set(arg, value);
    index += 1;
  }
  const sha = values.get("--sha");
  const version = values.get("--version");
  const output = values.get("--output");
  if (sha === undefined || version === undefined || output === undefined) {
    throw new Error("extract-notes requires --sha, --version, and --output");
  }
  return { sha, version, output };
}

async function main(args: string[]): Promise<void> {
  const mode = args[0];
  const repo = process.cwd();
  if (mode === "push") {
    const parsed = parseNamedArgs(args.slice(1), "push");
    const inspected = inspectReleaseIntent(repo, parsed.base, parsed.head);
    if (parsed.json) console.log(JSON.stringify(inspected));
    return;
  }
  if (mode === "refresh") {
    const parsed = parseNamedArgs(args.slice(1), "refresh");
    const inspected = inspectRefreshIntent(
      repo,
      parsed.base,
      parsed.head,
      parsed.version!,
      refreshContextFromEnvironment(),
    );
    if (parsed.json) console.log(JSON.stringify(inspected));
    return;
  }
  if (mode === "extract-notes") {
    const parsed = parseExtractArgs(args.slice(1));
    const sha = resolveCommit(repo, parsed.sha, "SHA");
    const version = stableVersion(parsed.version, "Release version");
    const changelog = strictText(readBlob(repo, sha, "CHANGELOG.md"), "CHANGELOG.md");
    const notes = extractChangelogSection(changelog, version);
    await Bun.write(path.resolve(repo, parsed.output), notes);
    return;
  }
  throw new Error(`Unknown command: ${mode ?? ""}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`release-intent: ${message}`);
    process.exitCode = 1;
  }
}
