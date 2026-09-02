import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTempDirs, git, ISOLATED, setupRepo, tempDir } from "./helpers/git";

afterEach(cleanupTempDirs);

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PREPARE_SCRIPT = path.join(REPO_ROOT, "scripts", "prepare-release.ts");
const RELEASE_VERSION_SCRIPT = path.join(REPO_ROOT, "scripts", "release-version.ts");
const RELEASE_CONFIG = path.join(REPO_ROOT, ".release-it.json");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");

interface FixtureOptions {
  changelog?: string;
  versionScript?: string;
}

function commit(repo: string, subject: string): void {
  git(repo, ["commit", "--allow-empty", "-m", subject]);
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setupReleaseRepo(options: FixtureOptions = {}): string {
  expect(existsSync(PREPARE_SCRIPT)).toBe(true);
  expect(existsSync(RELEASE_CONFIG)).toBe(true);

  const repo = setupRepo({ prefix: "prepare-release" });
  mkdirSync(path.join(repo, "scripts"));
  copyFileSync(PREPARE_SCRIPT, path.join(repo, "scripts", "prepare-release.ts"));
  copyFileSync(RELEASE_VERSION_SCRIPT, path.join(repo, "scripts", "release-version.ts"));
  copyFileSync(RELEASE_CONFIG, path.join(repo, ".release-it.json"));
  symlinkSync(NODE_MODULES, path.join(repo, "node_modules"));

  writeJson(path.join(repo, "package.json"), {
    name: "release-fixture",
    version: "1.0.0",
    private: true,
    repository: "https://github.com/Gusto/gusto-cli.git",
    ...(options.versionScript === undefined ? {} : { scripts: { version: options.versionScript } }),
  });
  writeFileSync(path.join(repo, "bun.lock"), "fixture lockfile\n");
  writeFileSync(
    path.join(repo, "CHANGELOG.md"),
    options.changelog ??
      "# Changelog\n\n## [1.0.0](https://github.com/Gusto/gusto-cli/releases/tag/v1.0.0)\n\n### Features\n\n* historical entry\n",
  );
  writeFileSync(path.join(repo, "EXTRA.md"), "unchanged\n");

  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: establish release history"]);
  git(repo, ["tag", "v1.0.0"]);

  const remote = tempDir("prepare-release-remote");
  git(remote, ["init", "--bare", "-q"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-q", "-u", "origin", "main", "--tags"]);
  return repo;
}

function pushMain(repo: string): void {
  git(repo, ["push", "-q", "origin", "main"]);
}

function runCli(repo: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, path.join(repo, "scripts", "prepare-release.ts"), ...args], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", ...ISOLATED, GITHUB_REPOSITORY: "example/release-fixture" },
  });
}

function expectFailure(result: ReturnType<typeof runCli>, message: RegExp): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toMatch(message);
}

function changedFiles(repo: string): string[] {
  return git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").filter(Boolean).sort();
}

function installFakeGh(_repo: string, response: "missing" | "exists" | "error"): string {
  const bin = tempDir("prepare-release-bin");
  const behavior = {
    missing: 'echo "gh: Not Found (HTTP 404)" >&2\nexit 1',
    exists: 'echo \'{"tag_name":"v1.1.0"}\'\nexit 0',
    error: 'echo "gh: authentication failed" >&2\nexit 1',
  }[response];
  const executable = path.join(bin, "gh");
  writeFileSync(executable, `#!/bin/sh\n${behavior}\n`);
  chmodSync(executable, 0o755);
  return bin;
}

function runRefresh(
  repo: string,
  version: string,
  ghResponse: "missing" | "exists" | "error" = "missing",
  configureBin?: (bin: string) => void,
) {
  const bin = installFakeGh(repo, ghResponse);
  configureBin?.(bin);
  return Bun.spawnSync([process.execPath, path.join(repo, "scripts", "prepare-release.ts"), "refresh", version], {
    cwd: repo,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ...ISOLATED,
      GITHUB_REPOSITORY: "example/release-fixture",
    },
  });
}

function installFailingGit(bin: string, command: "show-ref" | "ls-remote"): void {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git is required for this test");
  const executable = path.join(bin, "git");
  writeFileSync(
    executable,
    `#!/bin/sh\nif [ "$1" = "${command}" ]; then\n  echo "induced ${command} failure" >&2\n  exit ${command === "show-ref" ? "2" : "128"}\nfi\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(executable, 0o755);
}

function pushRemoteOnlyAnnotatedTag(repo: string, tag: string): void {
  const publisher = tempDir("prepare-release-tag-publisher");
  git(publisher, ["clone", "-q", git(repo, ["remote", "get-url", "origin"]), "."]);
  git(publisher, ["config", "user.name", "Jane Doe"]);
  git(publisher, ["config", "user.email", "jane@example.com"]);
  git(publisher, ["switch", "-q", "--orphan", "remote-tag-source"]);
  git(publisher, ["commit", "--allow-empty", "-m", "chore: remote tag source"]);
  git(publisher, ["tag", "-a", tag, "-m", tag]);
  git(publisher, ["push", "-q", "origin", `refs/tags/${tag}`]);
}

function repositoryState(repo: string) {
  return {
    branch: git(repo, ["branch", "--show-current"]),
    head: git(repo, ["rev-parse", "HEAD"]),
    index: git(repo, ["diff", "--cached", "--name-status"]),
    status: git(repo, ["status", "--porcelain", "--untracked-files=all"]),
    branches: git(repo, ["for-each-ref", "--format=%(refname:short)=%(objectname)", "refs/heads"]).split("\n").sort(),
    changelog: readFileSync(path.join(repo, "CHANGELOG.md"), "utf8"),
  };
}

describe("release preparation", () => {
  test("imports without running the CLI", () => {
    expect(existsSync(PREPARE_SCRIPT)).toBe(true);
    const result = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(PREPARE_SCRIPT)})`], {
      env: { PATH: process.env.PATH ?? "", ...ISOLATED },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });

  test("prepares the recommended version with the configured groups and effects", () => {
    const repo = setupReleaseRepo();
    const subjects = [
      "feat: add reports",
      "fix: correct responses",
      "perf: reduce startup time",
      "revert: restore compatible output",
      "docs: explain reports",
      "build: update packaging",
      "chore: tidy release files",
      "refactor: simplify parsing",
      "ci: adjust automation",
      "test: cover reports",
      "style: format reports",
    ];
    for (const subject of [...subjects].reverse()) commit(repo, subject);
    git(repo, ["tag", "v9.0.0-beta.1"]);
    pushMain(repo);
    const lockfile = readFileSync(path.join(repo, "bun.lock"), "utf8");
    expect(git(repo, ["log", "v1.0.0..HEAD", "--format=%s"])).toContain("feat: add reports");

    const directRecommendation = Bun.spawnSync(
      [process.execPath, path.join(repo, "scripts", "release-version.ts"), "--json"],
      { cwd: repo, env: { PATH: process.env.PATH ?? "", ...ISOLATED } },
    );
    expect(directRecommendation.stdout.toString()).toBe('{"kind":"release","version":"1.1.0","bump":"minor"}\n');

    const result = runCli(repo, "prepare");

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(git(repo, ["branch", "--show-current"])).toBe("chore/release-1.1.0");
    expect(JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version).toBe("1.1.0");
    expect(readFileSync(path.join(repo, "bun.lock"), "utf8")).toBe(lockfile);
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("chore: release 1.1.0");
    expect(git(repo, ["log", "-1", "--format=%B"])).toContain("Signed-off-by: Jane Doe <jane@example.com>");
    expect(changedFiles(repo)).toEqual(["CHANGELOG.md", "package.json"]);

    const changelog = readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
    const features = changelog.indexOf("### Features");
    const fixes = changelog.indexOf("### Fixes");
    const maintenance = changelog.indexOf("### Maintenance");
    expect(features).toBeGreaterThan(-1);
    expect(fixes).toBeGreaterThan(features);
    expect(maintenance).toBeGreaterThan(fixes);
    for (const visible of subjects.slice(0, 8).map((subject) => subject.split(": ")[1]!)) {
      expect(changelog).toContain(visible);
    }
    for (const hidden of subjects.slice(8).map((subject) => subject.split(": ")[1]!)) {
      expect(changelog).not.toContain(hidden);
    }
    expect(changelog).toContain("https://github.com/Gusto/gusto-cli/compare/v1.0.0...v1.1.0");
  });

  test("supports an explicit bootstrap version when automatic recommendation has no release", () => {
    const repo = setupReleaseRepo({ changelog: "# Changelog\n" });
    commit(repo, "docs: clarify installation");
    pushMain(repo);

    const result = runCli(repo, "prepare", "--version", "1.5.0");

    expect(result.exitCode).toBe(0);
    expect(git(repo, ["branch", "--show-current"])).toBe("chore/release-1.5.0");
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("chore: release 1.5.0");
    expect(readFileSync(path.join(repo, "CHANGELOG.md"), "utf8")).toContain("## [1.5.0]");
  });

  test("fails clearly when automatic recommendation has nothing to prepare", () => {
    const repo = setupReleaseRepo();
    commit(repo, "docs: clarify installation");
    pushMain(repo);

    expectFailure(runCli(repo, "prepare"), /No release is recommended; there is nothing to prepare/);
    expect(git(repo, ["branch", "--show-current"])).toBe("main");
  });

  test("requires a clean main branch at its current upstream commit", () => {
    const dirty = setupReleaseRepo();
    commit(dirty, "fix: correct a response");
    pushMain(dirty);
    writeFileSync(path.join(dirty, "EXTRA.md"), "dirty\n");
    expectFailure(runCli(dirty, "prepare"), /working tree must be clean/i);

    const wrongBranch = setupReleaseRepo();
    commit(wrongBranch, "fix: correct a response");
    pushMain(wrongBranch);
    git(wrongBranch, ["switch", "-q", "-c", "feature/not-main"]);
    expectFailure(runCli(wrongBranch, "prepare"), /must be run from main/i);

    const outdated = setupReleaseRepo();
    commit(outdated, "fix: local change");
    const other = tempDir("prepare-release-other");
    git(other, ["clone", "-q", git(outdated, ["remote", "get-url", "origin"]), "."]);
    git(other, ["config", "user.name", "Jane Doe"]);
    git(other, ["config", "user.email", "jane@example.com"]);
    commit(other, "fix: remote change");
    git(other, ["push", "-q", "origin", "main"]);
    expectFailure(runCli(outdated, "prepare"), /main must match its upstream/i);
  });

  test("refuses to commit an unexpected third file changed by release-it", () => {
    const repo = setupReleaseRepo({
      versionScript: "bun -e \"await Bun.write('EXTRA.md', 'unexpected\\n')\"",
    });
    commit(repo, "fix: correct a response");
    pushMain(repo);
    const before = git(repo, ["rev-parse", "HEAD"]);

    expectFailure(runCli(repo, "prepare"), /release-it changed unexpected files: EXTRA\.md/);

    expect(git(repo, ["branch", "--show-current"])).toBe("main");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(readFileSync(path.join(repo, "EXTRA.md"), "utf8")).toBe("unchanged\n");
  });

  test("rejects malformed preparation arguments without changing the repository", () => {
    const repo = setupReleaseRepo();
    const before = git(repo, ["rev-parse", "HEAD"]);

    expectFailure(runCli(repo, "prepare", "--unknown"), /Unknown argument/);
    expectFailure(runCli(repo, "prepare", "--version"), /--version requires one value/);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
  });
});

describe("release changelog refresh", () => {
  function prepareUnpublishedRelease(): string {
    const repo = setupReleaseRepo();
    commit(repo, "feat: add reports");
    pushMain(repo);
    expect(runCli(repo, "prepare", "--version", "1.1.0").exitCode).toBe(0);
    git(repo, ["switch", "-q", "main"]);
    git(repo, ["merge", "--ff-only", "chore/release-1.1.0"]);
    pushMain(repo);
    commit(repo, "fix: include late correction");
    commit(repo, "docs: document late correction");
    pushMain(repo);
    return repo;
  }

  test("regenerates only the leading unpublished section through current main", () => {
    const repo = prepareUnpublishedRelease();
    const before = readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
    const publishedHistory = before.slice(before.indexOf("## [1.0.0]"));
    const lockfile = readFileSync(path.join(repo, "bun.lock"), "utf8");
    const manifest = readFileSync(path.join(repo, "package.json"), "utf8");

    const result = runRefresh(repo, "1.1.0");

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(git(repo, ["branch", "--show-current"])).toBe("chore/refresh-release-1.1.0");
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("chore: refresh release 1.1.0");
    expect(git(repo, ["log", "-1", "--format=%B"])).toContain("Signed-off-by: Jane Doe <jane@example.com>");
    expect(changedFiles(repo)).toEqual(["CHANGELOG.md"]);
    expect(readFileSync(path.join(repo, "bun.lock"), "utf8")).toBe(lockfile);
    expect(readFileSync(path.join(repo, "package.json"), "utf8")).toBe(manifest);

    const refreshed = readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");
    expect(refreshed.slice(refreshed.indexOf("## [1.0.0]"))).toBe(publishedHistory);
    expect(refreshed.match(/^## \[1\.1\.0\]/gm)).toHaveLength(1);
    expect(refreshed).toContain("include late correction");
    expect(refreshed).toContain("document late correction");
    expect(refreshed).toContain("https://github.com/Gusto/gusto-cli/compare/v1.0.0...v1.1.0");
  });

  test("requires the package version and leading unpublished heading to match", () => {
    const wrongVersion = prepareUnpublishedRelease();
    expectFailure(runRefresh(wrongVersion, "1.2.0"), /must equal package\.json version 1\.1\.0/);

    const wrongHeading = prepareUnpublishedRelease();
    writeFileSync(
      path.join(wrongHeading, "CHANGELOG.md"),
      readFileSync(path.join(wrongHeading, "CHANGELOG.md"), "utf8").replace("## [1.1.0]", "## [1.0.9]"),
    );
    git(wrongHeading, ["add", "CHANGELOG.md"]);
    git(wrongHeading, ["commit", "-m", "docs: create mismatched changelog"]);
    pushMain(wrongHeading);
    expectFailure(runRefresh(wrongHeading, "1.1.0"), /leading changelog section must be 1\.1\.0/);
  }, 15_000);

  test("restores main when generated changelog verification fails", () => {
    const repo = prepareUnpublishedRelease();
    const manifest = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")) as Record<string, unknown>;
    manifest.repository = "https://github.com/example/different-repository.git";
    writeJson(path.join(repo, "package.json"), manifest);
    git(repo, ["add", "package.json"]);
    git(repo, ["commit", "-m", "chore: change repository metadata"]);
    pushMain(repo);
    const originalChangelog = readFileSync(path.join(repo, "CHANGELOG.md"), "utf8");

    expectFailure(runRefresh(repo, "1.1.0"), /Refreshed changelog is missing .*different-repository/);

    expect(git(repo, ["branch", "--show-current"])).toBe("main");
    expect(git(repo, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
    expect(readFileSync(path.join(repo, "CHANGELOG.md"), "utf8")).toBe(originalChangelog);
  });

  test("restores main and preserves a pre-existing colliding refresh branch", () => {
    const repo = prepareUnpublishedRelease();
    git(repo, ["branch", "chore/refresh-release-1.1.0"]);
    const before = repositoryState(repo);

    expectFailure(runRefresh(repo, "1.1.0"), /chore\/refresh-release-1\.1\.0.*already exists/s);

    expect(repositoryState(repo)).toEqual(before);
  });

  test("restores main and deletes only its new refresh branch when commit fails", () => {
    const repo = prepareUnpublishedRelease();
    const hook = path.resolve(repo, git(repo, ["rev-parse", "--git-path", "hooks/pre-commit"]));
    writeFileSync(hook, '#!/bin/sh\necho "induced commit failure" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const before = repositoryState(repo);

    expectFailure(runRefresh(repo, "1.1.0"), /induced commit failure/);

    expect(repositoryState(repo)).toEqual(before);
  });

  test("refuses a tagged version or existing release and fails closed when absence cannot be proven", () => {
    const tagged = prepareUnpublishedRelease();
    git(tagged, ["tag", "v1.1.0"]);
    expectFailure(runRefresh(tagged, "1.1.0"), /Tag v1\.1\.0 already exists/);

    const released = prepareUnpublishedRelease();
    expectFailure(runRefresh(released, "1.1.0", "exists"), /Release v1\.1\.0 already exists/);

    const unverifiable = prepareUnpublishedRelease();
    expectFailure(runRefresh(unverifiable, "1.1.0", "error"), /Could not verify whether release v1\.1\.0 exists/);
  }, 15_000);

  test("refuses an annotated tag that exists only on the remote", () => {
    const repo = prepareUnpublishedRelease();
    pushRemoteOnlyAnnotatedTag(repo, "v1.1.0");
    const localLookup = Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", "refs/tags/v1.1.0"], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", ...ISOLATED },
    });
    expect(localLookup.exitCode).toBe(1);

    expectFailure(runRefresh(repo, "1.1.0"), /Tag v1\.1\.0 already exists on origin/);
  });

  test("fails closed when local tag absence cannot be proven", () => {
    const localFailure = prepareUnpublishedRelease();
    expectFailure(
      runRefresh(localFailure, "1.1.0", "missing", (bin) => installFailingGit(bin, "show-ref")),
      /Could not verify whether tag v1\.1\.0 exists locally/,
    );
  });

  test("fails closed when remote tag absence cannot be proven", () => {
    const remoteFailure = prepareUnpublishedRelease();
    expectFailure(
      runRefresh(remoteFailure, "1.1.0", "missing", (bin) => installFailingGit(bin, "ls-remote")),
      /Could not verify whether tag v1\.1\.0 exists on origin/,
    );
  });
});
