import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTempDirs, git, ISOLATED, setupRepo, tempDir } from "./helpers/git";
import { extractChangelogSection, inspectRefreshIntent, inspectReleaseIntent } from "../scripts/release-intent.ts";

afterEach(cleanupTempDirs);

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const INTENT_SCRIPT = path.join(REPO_ROOT, "scripts", "release-intent.ts");
const REPOSITORY = "https://github.com/Gusto/gusto-cli";
const HISTORY =
  "## [1.0.0](https://github.com/Gusto/gusto-cli/releases/tag/v1.0.0) (2026-08-01)\n\n" +
  "### Features\n\n* historical entry\n";
const BASE_CHANGELOG = `# Changelog\n\n${HISTORY}`;
const RELEASE_SECTION =
  "## [1.1.0](https://github.com/Gusto/gusto-cli/compare/v1.0.0...v1.1.0) (2026-08-27)\n\n" +
  "### Features\n\n* add reports\n";
const RELEASE_CHANGELOG = `# Changelog\n\n${RELEASE_SECTION}\n${HISTORY}`;
const REFRESHED_SECTION =
  "## [1.1.0](https://github.com/Gusto/gusto-cli/compare/v1.0.0...v1.1.0) (2026-08-28)\n\n" +
  "### Features\n\n* add reports\n\n* add receipts\n";
const REFRESHED_CHANGELOG = `# Changelog\n\n${REFRESHED_SECTION}\n${HISTORY}`;

interface HistoryFixture {
  repo: string;
  base: string;
}

interface ReleaseFixture extends HistoryFixture {
  head: string;
}

function writePackage(repo: string, version: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify(
      {
        name: "release-intent-fixture",
        version,
        private: true,
        repository: REPOSITORY,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

function commitAll(repo: string, subject: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", subject]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function setupHistory(changelog = BASE_CHANGELOG): HistoryFixture {
  const repo = setupRepo({ prefix: "release-intent" });
  writePackage(repo, "1.0.0");
  writeFileSync(path.join(repo, "CHANGELOG.md"), changelog);
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  const base = commitAll(repo, "chore: establish release history");
  git(repo, ["tag", "-a", "v1.0.0", "-m", "v1.0.0"]);
  return { repo, base };
}

function prepareRelease(
  options: {
    changelog?: string | Uint8Array;
    packageVersion?: string;
    subject?: string;
    packageExtra?: Record<string, unknown>;
    extraChange?: boolean;
  } = {},
): ReleaseFixture {
  const fixture = setupHistory();
  writePackage(fixture.repo, options.packageVersion ?? "1.1.0", options.packageExtra);
  writeFileSync(path.join(fixture.repo, "CHANGELOG.md"), options.changelog ?? RELEASE_CHANGELOG);
  if (options.extraChange) writeFileSync(path.join(fixture.repo, "README.md"), "changed\n");
  const head = commitAll(fixture.repo, options.subject ?? "chore: release 1.1.0");
  return { ...fixture, head };
}

function prepareRefresh(mode: "pr" | "main" = "pr"): ReleaseFixture {
  const release = prepareRelease();
  if (mode === "pr") git(release.repo, ["switch", "-c", "refresh"]);
  writeFileSync(path.join(release.repo, "CHANGELOG.md"), REFRESHED_CHANGELOG);
  const head = commitAll(release.repo, "chore: refresh release 1.1.0");
  return { repo: release.repo, base: release.head, head };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface CliResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function runCli(repo: string, args: string[], extraEnv: Record<string, string> = {}): CliResult {
  const result = Bun.spawnSync([process.execPath, INTENT_SCRIPT, ...args], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", ...ISOLATED, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function expectFailure(operation: () => unknown, message: RegExp): void {
  expect(operation).toThrow(message);
}

describe("release intent", () => {
  test("classifies an exact release preparation and hashes independently extracted notes", () => {
    const { repo, base, head } = prepareRelease();

    expect(inspectReleaseIntent(repo, base, head)).toEqual({
      kind: "release",
      version: "1.1.0",
      commitSha: head,
      previousTag: "v1.0.0",
      releaseNotesSha256: sha256(RELEASE_SECTION),
    });
  });

  test("returns none for an ordinary commit", () => {
    const { repo, base } = setupHistory();
    writeFileSync(path.join(repo, "README.md"), "ordinary change\n");
    const head = commitAll(repo, "docs: clarify usage");

    expect(inspectReleaseIntent(repo, base, head)).toEqual({ kind: "none" });
  });

  test("fails closed for a release-shaped subject without a version change", () => {
    const { repo, base } = setupHistory();
    writeFileSync(path.join(repo, "README.md"), "changed\n");
    const head = commitAll(repo, "chore: release 1.1.0");

    expectFailure(() => inspectReleaseIntent(repo, base, head), /did not change package\.json version/);
  });

  test("requires the exact release subject and exactly the two expected modified paths", () => {
    const wrongSubject = prepareRelease({ subject: "chore: release v1.1.0" });
    expectFailure(
      () => inspectReleaseIntent(wrongSubject.repo, wrongSubject.base, wrongSubject.head),
      /subject must be exactly chore: release 1\.1\.0/,
    );

    const extra = prepareRelease({ extraChange: true });
    expectFailure(
      () => inspectReleaseIntent(extra.repo, extra.base, extra.head),
      /exactly CHANGELOG\.md and package\.json/,
    );

    const trailingSpace = prepareRelease();
    git(trailingSpace.repo, ["commit", "--amend", "--cleanup=verbatim", "-m", "chore: release 1.1.0 "]);
    trailingSpace.head = git(trailingSpace.repo, ["rev-parse", "HEAD"]);
    expectFailure(
      () => inspectReleaseIntent(trailingSpace.repo, trailingSpace.base, trailingSpace.head),
      /subject must be exactly chore: release 1\.1\.0/,
    );
  });

  test("rejects renames in the release diff", () => {
    const { repo, base } = setupHistory();
    git(repo, ["mv", "README.md", "NOTES.md"]);
    writePackage(repo, "1.1.0");
    writeFileSync(path.join(repo, "CHANGELOG.md"), RELEASE_CHANGELOG);
    const head = commitAll(repo, "chore: release 1.1.0");

    expectFailure(() => inspectReleaseIntent(repo, base, head), /modified paths/);
  });

  test("allows no parsed package change except a stable increasing version", () => {
    const metadata = prepareRelease({ packageExtra: { description: "new metadata" } });
    expectFailure(
      () => inspectReleaseIntent(metadata.repo, metadata.base, metadata.head),
      /only package\.json version/,
    );

    const prerelease = prepareRelease({ packageVersion: "1.1.0-rc.1", subject: "chore: release 1.1.0-rc.1" });
    expectFailure(
      () => inspectReleaseIntent(prerelease.repo, prerelease.base, prerelease.head),
      /stable semantic version/,
    );

    const regression = prepareRelease({ packageVersion: "0.9.0", subject: "chore: release 0.9.0" });
    expectFailure(
      () => inspectReleaseIntent(regression.repo, regression.base, regression.head),
      /greater than 1\.0\.0/,
    );
  });

  test("accepts only exact stable release versions", () => {
    for (const invalid of [
      "v1.1.0",
      "1.1.0-rc.1",
      "1.1.0+build.1",
      "01.1.0",
      "9007199254740992.0.0",
      "0.9007199254740992.0",
      "0.0.9007199254740992",
    ]) {
      expectFailure(() => extractChangelogSection(RELEASE_CHANGELOG, invalid), /stable semantic version/);
    }
  });

  test("filters malformed tags and sorts previous stable tags numerically", () => {
    const changelog =
      "# Changelog\n\n" +
      "## [11.0.0](https://github.com/Gusto/gusto-cli/compare/v10.0.0...v11.0.0) (2026-08-27)\n\n" +
      "### Features\n\n* add reports\n\n" +
      HISTORY;
    const release = prepareRelease({
      changelog,
      packageVersion: "11.0.0",
      subject: "chore: release 11.0.0",
    });
    for (const tag of ["v2.100.0", "v10.0.0", "v999.0.0+build.1", "v01.0.0", "v2.0.0-rc.1"]) {
      git(release.repo, ["tag", tag, release.base]);
    }

    expect(inspectReleaseIntent(release.repo, release.base, release.head)).toMatchObject({
      kind: "release",
      version: "11.0.0",
      previousTag: "v10.0.0",
    });
  });

  test("requires one leading section, the exact comparison link, and immutable history bytes", () => {
    const wrongLink = prepareRelease({
      changelog: RELEASE_CHANGELOG.replace("v1.0.0...v1.1.0", "v0.9.0...v1.1.0"),
    });
    expectFailure(() => inspectReleaseIntent(wrongLink.repo, wrongLink.base, wrongLink.head), /comparison link/);

    const historicalEdit = prepareRelease({ changelog: RELEASE_CHANGELOG.replace("historical entry", "rewritten") });
    expectFailure(
      () => inspectReleaseIntent(historicalEdit.repo, historicalEdit.base, historicalEdit.head),
      /historical changelog bytes/,
    );

    const secondSection = prepareRelease({
      changelog: RELEASE_CHANGELOG.replace(`\n${HISTORY}`, `\n## [1.0.5]\n\n* unexpected\n\n${HISTORY}`),
    });
    expectFailure(
      () => inspectReleaseIntent(secondSection.repo, secondSection.base, secondSection.head),
      /exactly one leading/,
    );
  });

  test("supports only the reviewed v0.3.0 header-only bootstrap shape", () => {
    const repo = setupRepo({ prefix: "release-bootstrap" });
    writePackage(repo, "0.2.0");
    writeFileSync(path.join(repo, "CHANGELOG.md"), "# Changelog\n");
    const base = commitAll(repo, "chore: establish bootstrap base");
    git(repo, ["tag", "v0.2.0"]);
    writePackage(repo, "0.3.0");
    const section =
      "## [0.3.0](https://github.com/Gusto/gusto-cli/compare/v0.2.0...v0.3.0) (2026-08-27)\n\n" +
      "### Features\n\n* curated bootstrap notes\n";
    writeFileSync(path.join(repo, "CHANGELOG.md"), `# Changelog\n\n${section}`);
    const head = commitAll(repo, "chore: release 0.3.0");

    expect(inspectReleaseIntent(repo, base, head)).toEqual({
      kind: "release",
      version: "0.3.0",
      commitSha: head,
      previousTag: "v0.2.0",
      releaseNotesSha256: sha256(section),
    });

    const wrongBase = setupRepo({ prefix: "release-not-bootstrap" });
    writePackage(wrongBase, "0.3.0");
    writeFileSync(path.join(wrongBase, "CHANGELOG.md"), "# Changelog\n");
    const wrongBaseSha = commitAll(wrongBase, "chore: establish base");
    git(wrongBase, ["tag", "v0.3.0"]);
    writePackage(wrongBase, "0.4.0");
    writeFileSync(
      path.join(wrongBase, "CHANGELOG.md"),
      "# Changelog\n\n## [0.4.0](https://github.com/Gusto/gusto-cli/compare/v0.3.0...v0.4.0)\n\n* notes\n",
    );
    const wrongHead = commitAll(wrongBase, "chore: release 0.4.0");
    expectFailure(() => inspectReleaseIntent(wrongBase, wrongBaseSha, wrongHead), /header-only bootstrap/);
  });

  test("rejects missing first-parent ancestry and a version tag, including annotated tags", () => {
    const ancestry = prepareRelease();
    git(ancestry.repo, ["switch", "--detach", ancestry.base]);
    const unrelated = git(ancestry.repo, ["commit-tree", `${ancestry.base}^{tree}`, "-m", "chore: unrelated"]);
    expectFailure(() => inspectReleaseIntent(ancestry.repo, unrelated, ancestry.head), /first-parent descendant/);

    const tagged = prepareRelease();
    git(tagged.repo, ["tag", "-a", "v1.1.0", "-m", "published", tagged.head]);
    expectFailure(() => inspectReleaseIntent(tagged.repo, tagged.base, tagged.head), /Tag v1\.1\.0 already exists/);

    const newerPublished = prepareRelease();
    git(newerPublished.repo, ["tag", "v2.0.0", newerPublished.base]);
    expectFailure(
      () => inspectReleaseIntent(newerPublished.repo, newerPublished.base, newerPublished.head),
      /must be greater than previous stable tag v2\.0\.0/,
    );
  });

  test("retains first-parent ancestry for a normal release", () => {
    const { repo } = setupHistory();
    git(repo, ["commit", "--allow-empty", "-m", "docs: advance target base"]);
    const base = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["switch", "-c", "release-side", "v1.0.0^{}"]);
    git(repo, ["commit", "--allow-empty", "-m", "docs: start release side branch"]);
    git(repo, ["merge", "--no-ff", "--no-commit", base]);
    writePackage(repo, "1.1.0");
    writeFileSync(path.join(repo, "CHANGELOG.md"), RELEASE_CHANGELOG);
    const head = commitAll(repo, "chore: release 1.1.0");

    expectFailure(() => inspectReleaseIntent(repo, base, head), /first-parent descendant/);
  });

  test("rejects malformed JSON and CRLF or binary changelog data", () => {
    const malformed = prepareRelease();
    writeFileSync(path.join(malformed.repo, "package.json"), "{not json}\n");
    const malformedHead = commitAll(malformed.repo, "chore: release 1.2.0");
    expectFailure(() => inspectReleaseIntent(malformed.repo, malformed.head, malformedHead), /package\.json.*JSON/);

    const crlf = prepareRelease({ changelog: RELEASE_CHANGELOG.replaceAll("\n", "\r\n") });
    expectFailure(() => inspectReleaseIntent(crlf.repo, crlf.base, crlf.head), /LF text/);

    const binary = prepareRelease({ changelog: new Uint8Array([0xff, 0x00, 0x41]) });
    expectFailure(() => inspectReleaseIntent(binary.repo, binary.base, binary.head), /UTF-8 text/);
  });
});

describe("refresh intent", () => {
  test("accepts a refresh PR whose head descends from the target base", () => {
    const { repo, base, head } = prepareRefresh("pr");

    expect(inspectRefreshIntent(repo, base, head, "1.1.0", "pr")).toEqual({
      kind: "refresh",
      version: "1.1.0",
      commitSha: head,
      previousTag: "v1.0.0",
      releaseNotesSha256: sha256(REFRESHED_SECTION),
    });
  });

  test("accepts a refresh PR when the target base is the merge commit's second parent", () => {
    const release = prepareRelease();
    git(release.repo, ["switch", "-c", "refresh-side", `${release.base}`]);
    git(release.repo, ["commit", "--allow-empty", "-m", "docs: start refresh side branch"]);
    git(release.repo, ["merge", "--no-ff", "--no-commit", release.head]);
    writeFileSync(path.join(release.repo, "CHANGELOG.md"), REFRESHED_CHANGELOG);
    const head = commitAll(release.repo, "chore: refresh release 1.1.0");

    expect(git(release.repo, ["rev-parse", "HEAD^2"])).toBe(release.head);
    expect(inspectRefreshIntent(release.repo, release.head, head, "1.1.0", "pr").kind).toBe("refresh");
  });

  test("falls back to local main for post-merge validation when origin/main is absent", () => {
    const merged = prepareRefresh("main");
    expect(inspectRefreshIntent(merged.repo, merged.base, merged.head, "1.1.0").kind).toBe("refresh");
  });

  test("prefers origin/main and rejects a contradictory local main", () => {
    const merged = prepareRefresh("main");
    git(merged.repo, ["update-ref", "refs/remotes/origin/main", merged.base]);

    expectFailure(() => inspectRefreshIntent(merged.repo, merged.base, merged.head, "1.1.0"), /origin\/main/);
  });

  test("defaults to post-merge validation and rejects an arbitrary branch SHA", () => {
    const arbitrary = prepareRefresh("pr");
    expectFailure(
      () => inspectRefreshIntent(arbitrary.repo, arbitrary.base, arbitrary.head, "1.1.0"),
      /head must be reachable from main/,
    );
  });

  test("requires equal package versions, the requested version, and the exact subject", () => {
    const changedVersion = prepareRefresh();
    git(changedVersion.repo, ["reset", "--hard", changedVersion.base]);
    writePackage(changedVersion.repo, "1.2.0");
    writeFileSync(path.join(changedVersion.repo, "CHANGELOG.md"), REFRESHED_CHANGELOG);
    const changedHead = commitAll(changedVersion.repo, "chore: refresh release 1.2.0");
    expectFailure(
      () => inspectRefreshIntent(changedVersion.repo, changedVersion.base, changedHead, "1.2.0", "pr"),
      /must not change package\.json version/,
    );

    const requested = prepareRefresh();
    expectFailure(
      () => inspectRefreshIntent(requested.repo, requested.base, requested.head, "1.2.0", "pr"),
      /must equal package/,
    );

    const subject = prepareRelease();
    git(subject.repo, ["switch", "-c", "refresh"]);
    writeFileSync(path.join(subject.repo, "CHANGELOG.md"), REFRESHED_CHANGELOG);
    const subjectHead = commitAll(subject.repo, "docs: refresh notes");
    expectFailure(
      () => inspectRefreshIntent(subject.repo, subject.head, subjectHead, "1.1.0", "pr"),
      /subject must be exactly chore: refresh release 1\.1\.0/,
    );
  });

  test("requires exactly one changed changelog and a materially changed leading section", () => {
    const extra = prepareRelease();
    git(extra.repo, ["switch", "-c", "refresh"]);
    writeFileSync(path.join(extra.repo, "CHANGELOG.md"), REFRESHED_CHANGELOG);
    writeFileSync(path.join(extra.repo, "README.md"), "also changed\n");
    const extraHead = commitAll(extra.repo, "chore: refresh release 1.1.0");
    expectFailure(
      () => inspectRefreshIntent(extra.repo, extra.head, extraHead, "1.1.0", "pr"),
      /exactly CHANGELOG\.md/,
    );

    const unchanged = prepareRelease();
    git(unchanged.repo, ["switch", "-c", "refresh"]);
    git(unchanged.repo, ["commit", "--allow-empty", "-m", "chore: refresh release 1.1.0"]);
    const emptyHead = git(unchanged.repo, ["rev-parse", "HEAD"]);
    expectFailure(
      () => inspectRefreshIntent(unchanged.repo, unchanged.head, emptyHead, "1.1.0", "pr"),
      /exactly CHANGELOG\.md/,
    );
  });

  test("rejects historical edits, an inaccurate link, and a tagged target", () => {
    const history = prepareRelease();
    git(history.repo, ["switch", "-c", "refresh"]);
    writeFileSync(
      path.join(history.repo, "CHANGELOG.md"),
      REFRESHED_CHANGELOG.replace("historical entry", "rewritten"),
    );
    const historyHead = commitAll(history.repo, "chore: refresh release 1.1.0");
    expectFailure(
      () => inspectRefreshIntent(history.repo, history.head, historyHead, "1.1.0", "pr"),
      /historical changelog bytes/,
    );

    const link = prepareRelease();
    git(link.repo, ["switch", "-c", "refresh"]);
    writeFileSync(
      path.join(link.repo, "CHANGELOG.md"),
      REFRESHED_CHANGELOG.replace("v1.0.0...v1.1.0", "v1.0.1...v1.1.0"),
    );
    const linkHead = commitAll(link.repo, "chore: refresh release 1.1.0");
    expectFailure(() => inspectRefreshIntent(link.repo, link.head, linkHead, "1.1.0", "pr"), /comparison link/);

    const tagged = prepareRefresh();
    git(tagged.repo, ["tag", "v1.1.0", tagged.head]);
    expectFailure(
      () => inspectRefreshIntent(tagged.repo, tagged.base, tagged.head, "1.1.0", "pr"),
      /Tag v1\.1\.0 already exists/,
    );
  });

  test("rejects a head that does not descend from the supplied target base", () => {
    const refresh = prepareRefresh();
    const unrelated = git(refresh.repo, ["commit-tree", `${refresh.base}^{tree}`, "-m", "chore: unrelated root"]);
    expectFailure(
      () => inspectRefreshIntent(refresh.repo, unrelated, refresh.head, "1.1.0", "pr"),
      /descendant of base/,
    );
  });
});

describe("changelog extraction and CLI", () => {
  test("a copied script starts without a package or node_modules tree", () => {
    const clean = tempDir("release-intent-clean");
    const copiedScript = path.join(clean, "release-intent.ts");
    copyFileSync(INTENT_SCRIPT, copiedScript);

    const result = Bun.spawnSync([process.execPath, copiedScript, "invalid-command"], {
      cwd: clean,
      env: { PATH: process.env.PATH ?? "", ...ISOLATED },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("release-intent: Unknown command: invalid-command\n");
  });

  test("extracts exactly one version section with one trailing newline", () => {
    expect(extractChangelogSection(RELEASE_CHANGELOG, "1.1.0")).toBe(RELEASE_SECTION);
    expectFailure(() => extractChangelogSection(RELEASE_CHANGELOG, "1.2.0"), /section 1\.2\.0/);
    expectFailure(() => extractChangelogSection(`${RELEASE_CHANGELOG}\r\n`, "1.1.0"), /LF text/);
    expectFailure(() => extractChangelogSection(RELEASE_CHANGELOG, "1.1.0-rc.1"), /stable semantic version/);
    expectFailure(
      () => extractChangelogSection(RELEASE_CHANGELOG.replace("## [1.0.0]", "## malformed"), "1.1.0"),
      /Malformed changelog heading/,
    );
  });

  test("push JSON stdout contains only the stable release record fields", () => {
    const { repo, base, head } = prepareRelease();
    const result = runCli(repo, ["push", "--base", base, "--head", head, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      kind: "release",
      version: "1.1.0",
      commitSha: head,
      previousTag: "v1.0.0",
      releaseNotesSha256: sha256(RELEASE_SECTION),
    });
  });

  test("ordinary push JSON is only the none classification", () => {
    const { repo, base } = setupHistory();
    writeFileSync(path.join(repo, "README.md"), "changed\n");
    const head = commitAll(repo, "docs: clarify usage");
    const result = runCli(repo, ["push", "--base", base, "--head", head, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe('{"kind":"none"}\n');
  });

  test("refresh CLI emits its classification and diagnostics never contaminate stdout", () => {
    const refresh = prepareRefresh();
    const valid = runCli(
      refresh.repo,
      ["refresh", "--base", refresh.base, "--head", refresh.head, "--version", "1.1.0", "--json"],
      { RELEASE_INTENT_CONTEXT: "pr" },
    );
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout.toString()).kind).toBe("refresh");
    expect(valid.stderr.toString()).toBe("");

    const malformed = prepareRelease({ subject: "chore: release v1.1.0" });
    const invalid = runCli(malformed.repo, ["push", "--base", malformed.base, "--head", malformed.head, "--json"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stdout.toString()).toBe("");
    expect(invalid.stderr.toString()).toMatch(/^release-intent:/);
  });

  test("refresh CLI rejects unknown trusted invocation contexts", () => {
    const refresh = prepareRefresh();
    const result = runCli(
      refresh.repo,
      ["refresh", "--base", refresh.base, "--head", refresh.head, "--version", "1.1.0", "--json"],
      { RELEASE_INTENT_CONTEXT: "unexpected" },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toMatch(/Unknown RELEASE_INTENT_CONTEXT/);
  });

  test("extract-notes reads the requested commit and writes exact normalized bytes", () => {
    const { repo, head } = prepareRelease();
    mkdirSync(path.join(repo, "out"));
    const output = path.join(repo, "out", "release-notes.md");
    const result = runCli(repo, ["extract-notes", "--sha", head, "--version", "1.1.0", "--output", output]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
    expect(readFileSync(output, "utf8")).toBe(RELEASE_SECTION);
  });

  test("rejects malformed CLI arguments without writing output", () => {
    const { repo, head } = prepareRelease();
    const output = path.join(repo, "notes.md");
    const result = runCli(repo, ["extract-notes", "--sha", head, "--version", "1.1.0", "--output", output, "extra"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toMatch(/Unknown argument/);
    expect(Bun.file(output).size).toBe(0);
  });
});
