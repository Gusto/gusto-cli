import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import semver from "semver";
import type { Recommendation } from "./release-version.ts";

type ChangeMode = "release" | "refresh";

const RELEASE_IT = path.resolve(import.meta.dir, "../node_modules/release-it/bin/release-it.js");

function output(result: ReturnType<typeof Bun.spawnSync>, stream: "stdout" | "stderr"): string {
  return result[stream]?.toString() ?? "";
}

function run(command: string[], options: { allowFailure?: boolean } = {}): ReturnType<typeof Bun.spawnSync> {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (!options.allowFailure && result.exitCode !== 0) {
    const detail = output(result, "stderr").trim() || output(result, "stdout").trim();
    throw new Error(`${command[0]} failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return result;
}

function runGit(args: string[], options: { allowFailure?: boolean } = {}): string {
  return output(run(["git", ...args], options), "stdout").trim();
}

function stableVersion(version: string, label: string): string {
  const parsed = semver.parse(version);
  if (parsed === null || version.startsWith("v") || parsed.prerelease.length > 0) {
    throw new Error(`${label} must be a stable semantic version`);
  }
  return version;
}

function assertCleanCurrentMain(): void {
  const branch = runGit(["branch", "--show-current"]);
  if (branch !== "main") throw new Error("Release preparation must be run from main");

  const status = runGit(["status", "--porcelain", "--untracked-files=all"]);
  if (status !== "") throw new Error("The working tree must be clean before release preparation");

  const upstreamResult = run(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], { allowFailure: true });
  if (upstreamResult.exitCode !== 0) throw new Error("main must have an upstream branch");
  const upstream = output(upstreamResult, "stdout").trim();
  runGit(["fetch", "--quiet"]);
  if (runGit(["rev-parse", "HEAD"]) !== runGit(["rev-parse", upstream])) {
    throw new Error("main must match its upstream before release preparation");
  }
}

function parsePrepareArgs(args: string[]): string | null {
  if (args.length === 0) return null;
  if (args[0] !== "--version") throw new Error(`Unknown argument: ${args[0]}`);
  if (args.length !== 2) throw new Error("--version requires one value");
  return args[1]!;
}

function recommendation(explicitVersion: string | null): Recommendation {
  const args = [process.execPath, path.join(import.meta.dir, "release-version.ts"), "--json"];
  if (explicitVersion !== null) args.push("--version", explicitVersion);
  const result = run(args);
  const parsed: unknown = JSON.parse(output(result, "stdout"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    (parsed.kind !== "none" && parsed.kind !== "release")
  ) {
    throw new Error("The release recommender returned an invalid result");
  }
  return parsed as Recommendation;
}

function releaseBranch(mode: ChangeMode, version: string): string {
  return `chore/${mode === "release" ? "release" : "refresh-release"}-${version}`;
}

function changedPaths(): string[] {
  return output(run(["git", "status", "--porcelain", "--untracked-files=all"]), "stdout")
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((file) => (file.includes(" -> ") ? file.split(" -> ")[1]! : file))
    .sort();
}

function expectedChanges(mode: ChangeMode): string[] {
  return mode === "release" ? ["CHANGELOG.md", "package.json"] : ["CHANGELOG.md"];
}

function verifyChanges(mode: ChangeMode): void {
  const actual = changedPaths();
  const expected = expectedChanges(mode);
  const unexpected = actual.filter((file) => !expected.includes(file));
  const missing = expected.filter((file) => !actual.includes(file));
  if (unexpected.length > 0) throw new Error(`release-it changed unexpected files: ${unexpected.join(", ")}`);
  if (missing.length > 0) throw new Error(`release-it did not change required files: ${missing.join(", ")}`);
}

function createBranch(mode: ChangeMode, version: string): void {
  stableVersion(version, "Release version");
  runGit(["switch", "-c", releaseBranch(mode, version)]);
}

function releaseIt(version: string, args: string[] = []): ReturnType<typeof Bun.spawnSync> {
  return run([process.execPath, RELEASE_IT, version, "--ci", "--quiet", ...args], { allowFailure: true });
}

function restoreMainAfterFailure(branch: string): void {
  const current = runGit(["branch", "--show-current"], { allowFailure: true });
  if (current === branch) {
    runGit(["switch", "-q", "main"], { allowFailure: true });
    runGit(["branch", "-D", branch], { allowFailure: true });
  }
}

function prepare(args: string[]): void {
  const explicitVersion = parsePrepareArgs(args);
  assertCleanCurrentMain();
  const result = recommendation(explicitVersion);
  if (result.kind === "none") throw new Error("No release is recommended; there is nothing to prepare");

  const branch = releaseBranch("release", result.version);
  const prepared = releaseIt(result.version);
  if (prepared.exitCode !== 0) {
    restoreMainAfterFailure(branch);
    const detail = output(prepared, "stderr").trim() || output(prepared, "stdout").trim();
    throw new Error(detail || "release-it failed to prepare the release");
  }
  if (runGit(["branch", "--show-current"]) !== branch) throw new Error(`release-it did not create ${branch}`);
  if (runGit(["log", "-1", "--format=%s"]) !== `chore: release ${result.version}`) {
    throw new Error("release-it did not create the expected release commit");
  }
}

interface ChangelogSection {
  history: string;
  temporary: string;
}

function unpublishedSection(content: string, version: string): ChangelogSection {
  if (!content.startsWith("# Changelog")) throw new Error("CHANGELOG.md must start with # Changelog");
  const headings = [...content.matchAll(/^## \[([^\]]+)\][^\n]*$/gm)];
  const leading = headings[0];
  if (leading === undefined || leading.index === undefined || leading[1] !== version) {
    throw new Error(`The leading changelog section must be ${version}`);
  }
  if (content.slice("# Changelog".length, leading.index).trim() !== "") {
    throw new Error(`The leading changelog section must be ${version}`);
  }
  const historyIndex = headings[1]?.index ?? content.length;
  const history = content.slice(historyIndex);
  const header = content.slice(0, leading.index).trimEnd();
  return { history, temporary: `${header}\n${history === "" ? "" : `\n${history}`}` };
}

function repositorySlug(): string {
  const fromEnvironment = process.env.GITHUB_REPOSITORY;
  if (fromEnvironment !== undefined && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fromEnvironment)) {
    return fromEnvironment;
  }
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { repository?: string | { url?: string } };
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const match = repository?.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match === undefined || match === null) throw new Error("Unable to determine the public GitHub repository");
  return `${match[1]}/${match[2]}`;
}

function assertNoPublishedRelease(version: string): void {
  const tag = `v${version}`;
  const localTag = run(["git", "show-ref", "--verify", "--quiet", `refs/tags/${tag}`], { allowFailure: true });
  if (localTag.exitCode === 0) {
    throw new Error(`Tag ${tag} already exists; published changelog sections cannot be refreshed`);
  }
  if (localTag.exitCode !== 1) throw new Error(`Could not verify whether tag ${tag} exists locally`);

  const remoteTag = run(
    ["git", "ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { allowFailure: true },
  );
  if (remoteTag.exitCode === 0) {
    throw new Error(`Tag ${tag} already exists on origin; published changelog sections cannot be refreshed`);
  }
  if (remoteTag.exitCode !== 2) throw new Error(`Could not verify whether tag ${tag} exists on origin`);

  const release = run(["gh", "api", "--silent", `repos/${repositorySlug()}/releases/tags/${tag}`], {
    allowFailure: true,
  });
  if (release.exitCode === 0)
    throw new Error(`Release ${tag} already exists; published changelog sections cannot be refreshed`);
  if (!/HTTP 404/.test(output(release, "stderr"))) {
    throw new Error(`Could not verify whether release ${tag} exists`);
  }
}

function latestStableTag(): string {
  const tags = runGit(["tag", "--list", "v*.*.*"])
    .split("\n")
    .filter(Boolean)
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .filter(({ version }) => semver.valid(version) !== null && semver.prerelease(version) === null)
    .sort((left, right) => semver.rcompare(left.version, right.version));
  if (tags.length === 0) throw new Error("No stable v*.*.* tag exists");
  return tags[0]!.tag;
}

function expectedComparisonLink(previousTag: string, version: string): string {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { repository?: string | { url?: string } };
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (repository === undefined) throw new Error("package.json repository is required for changelog links");
  const base = repository.replace(/^git\+/, "").replace(/\.git$/, "");
  return `${base}/compare/${previousTag}...v${version}`;
}

function restoreRefreshState(originalChangelog: string): void {
  writeFileSync("CHANGELOG.md", originalChangelog);
  runGit(["reset", "--quiet", "HEAD", "--", "CHANGELOG.md", "package.json"], { allowFailure: true });
}

function rollbackRefreshCommit(originalHead: string, branch: string, createdBranch: boolean): void {
  runGit(["restore", "--source", originalHead, "--staged", "--worktree", "--", "CHANGELOG.md"]);
  if (runGit(["branch", "--show-current"]) !== "main") runGit(["switch", "-q", "main"]);
  if (createdBranch) runGit(["branch", "-D", branch]);
  if (runGit(["rev-parse", "HEAD"]) !== originalHead)
    throw new Error("Refresh rollback did not restore the original HEAD");
}

function refresh(versionArgument: string): void {
  const version = stableVersion(versionArgument, "Refresh version");
  assertCleanCurrentMain();
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
  if (manifest.version !== version)
    throw new Error(`Refresh version ${version} must equal package.json version ${manifest.version}`);

  const originalChangelog = readFileSync("CHANGELOG.md", "utf8");
  const originalHead = runGit(["rev-parse", "HEAD"]);
  const section = unpublishedSection(originalChangelog, version);
  assertNoPublishedRelease(version);
  const previousTag = latestStableTag();
  const branch = releaseBranch("refresh", version);
  writeFileSync("CHANGELOG.md", section.temporary);

  const refreshed = releaseIt(version, [
    "--npm.allowSameVersion",
    "--no-git.requireCleanWorkingDir",
    "--no-git.commit",
    "--no-hooks.after:bump",
    "--hooks.before:git:release=bun run scripts/prepare-release.ts verify-changes refresh",
  ]);
  if (refreshed.exitCode !== 0) {
    restoreRefreshState(originalChangelog);
    restoreMainAfterFailure(branch);
    const detail = output(refreshed, "stderr").trim() || output(refreshed, "stdout").trim();
    throw new Error(detail || "release-it failed to refresh the changelog");
  }

  try {
    verifyChanges("refresh");
    const finalChangelog = readFileSync("CHANGELOG.md", "utf8");
    const heading = `## [${version}]`;
    const comparisonLink = expectedComparisonLink(previousTag, version);
    if (!finalChangelog.startsWith(`# Changelog\n\n${heading}`))
      throw new Error(`Refreshed changelog is missing ${heading}`);
    if (!finalChangelog.includes(comparisonLink)) throw new Error(`Refreshed changelog is missing ${comparisonLink}`);
    if (!finalChangelog.endsWith(section.history)) throw new Error("Refreshed changelog changed published history");
  } catch (error) {
    restoreRefreshState(originalChangelog);
    throw error;
  }

  let createdBranch = false;
  try {
    createBranch("refresh", version);
    createdBranch = true;
    runGit(["add", "--", "CHANGELOG.md"]);
    runGit(["commit", "--signoff", "--message", `chore: refresh release ${version}`]);
  } catch (error) {
    rollbackRefreshCommit(originalHead, branch, createdBranch);
    throw error;
  }
}

function main(args: string[]): void {
  const command = args[0];
  if (command === "prepare") return prepare(args.slice(1));
  if (command === "refresh") {
    if (args.length !== 2) throw new Error("release:refresh requires one version");
    return refresh(args[1]!);
  }
  if (command === "create-branch") {
    if ((args[1] !== "release" && args[1] !== "refresh") || args.length !== 3)
      throw new Error("Invalid branch hook arguments");
    return createBranch(args[1], args[2]!);
  }
  if (command === "verify-changes") {
    if ((args[1] !== "release" && args[1] !== "refresh") || args.length !== 2)
      throw new Error("Invalid verification hook arguments");
    return verifyChanges(args[1]);
  }
  throw new Error(`Unknown command: ${command ?? ""}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`prepare-release: ${message}`);
    process.exitCode = 1;
  }
}
