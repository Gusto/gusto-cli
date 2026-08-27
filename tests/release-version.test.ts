import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanupTempDirs, git, ISOLATED, setupRepo } from "./helpers/git";
import { parseConventionalCommit, recommendRelease } from "../scripts/release-version.ts";

afterEach(cleanupTempDirs);

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "release-version.ts");

function commit(repo: string, subject: string, body?: string): void {
  const args = ["commit", "--allow-empty", "-m", subject];
  if (body !== undefined) args.push("-m", body);
  git(repo, args);
}

function runCli(repo: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? "", ...ISOLATED },
  });
}

describe("parseConventionalCommit", () => {
  test("does not execute the CLI when the pure API is imported", () => {
    const repo = setupRepo({ prefix: "release-version-import" });
    const result = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(SCRIPT)})`], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", ...ISOLATED },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });

  test("recognizes a scoped breaking header", () => {
    expect(parseConventionalCommit("feat(api)!: replace output")).toEqual({ type: "feat", breaking: true });
  });

  test("recognizes both supported breaking footer spellings", () => {
    expect(parseConventionalCommit("fix: correct response\n\nBREAKING-CHANGE: old clients stop working")).toEqual({
      type: "fix",
      breaking: true,
    });
  });

  test("does not classify an unconventional subject as a conventional type", () => {
    expect(parseConventionalCommit("add generated report")).toEqual({ type: null, breaking: false });
  });
});

describe("recommendRelease", () => {
  const bumpMatrix: Array<[string, string[], { version: string; bump: "patch" | "minor" | "major" }]> = [
    ["0.2.0", ["feat: add reports"], { version: "0.3.0", bump: "minor" }],
    ["0.2.0", ["feat!: change output"], { version: "0.3.0", bump: "minor" }],
    ["0.2.0", ["fix: reject bad UUID"], { version: "0.2.1", bump: "patch" }],
    ["1.2.3", ["fix!: change output"], { version: "2.0.0", bump: "major" }],
    ["0.2.0", ["perf: reduce startup time"], { version: "0.2.1", bump: "patch" }],
    ["0.2.0", ["revert: restore prior output"], { version: "0.2.1", bump: "patch" }],
  ];

  test.each(bumpMatrix)("recommends %s from the explicit bump matrix", (current, messages, expected) => {
    expect(recommendRelease(current, messages)).toEqual({ kind: "release", ...expected });
  });

  test("uses a breaking footer for a stable-major release", () => {
    expect(recommendRelease("1.2.3", ["fix: change output\n\nBREAKING CHANGE: old clients stop working"])).toEqual({
      kind: "release",
      version: "2.0.0",
      bump: "major",
    });
  });

  test("prefers the highest bump across mixed commits", () => {
    expect(
      recommendRelease("1.2.3", ["fix: correct a typo", "feat: add reports", "perf!: replace the output format"]),
    ).toEqual({ kind: "release", version: "2.0.0", bump: "major" });
  });

  test("does not let a malformed subject contribute a release", () => {
    expect(recommendRelease("1.2.3", ["add a new report", "docs: document reports"])).toEqual({ kind: "none" });
  });

  test("does not let a breaking footer without a conventional header contribute a release", () => {
    expect(recommendRelease("1.2.3", ["replace the output\n\nBREAKING CHANGE: old clients stop working"])).toEqual({
      kind: "none",
    });
  });

  test("does not treat a newline as a conventional header description", () => {
    expect(
      recommendRelease("1.2.3", ["fix:\ncorrect the output\n\nBREAKING CHANGE: old clients stop working"]),
    ).toEqual({
      kind: "none",
    });
  });

  test("does not treat breaking text in an ordinary body paragraph as a footer", () => {
    expect(
      recommendRelease("1.2.3", [
        "fix: correct the output\n\nBREAKING CHANGE: describes a compatibility concern in the body\n\nMore body text follows.",
      ]),
    ).toEqual({ kind: "release", version: "1.2.4", bump: "patch" });
  });

  test("returns no recommendation for non-release-affecting commits", () => {
    expect(recommendRelease("0.2.0", ["docs: clarify install"])).toEqual({ kind: "none" });
  });

  test("rejects malformed and prerelease current versions", () => {
    expect(() => recommendRelease("not-a-version", ["fix: correct a typo"])).toThrow();
    expect(() => recommendRelease("1.2.3-beta.1", ["fix: correct a typo"])).toThrow();
  });

  test("accepts stable current versions with build metadata", () => {
    expect(recommendRelease("1.2.3+build.7", ["fix: correct a typo"])).toEqual({
      kind: "release",
      version: "1.2.4",
      bump: "patch",
    });
  });
});

describe("release-version CLI", () => {
  test("uses the greatest stable tag and retains a multiline commit body as one record", () => {
    const repo = setupRepo({ prefix: "release-version" });
    commit(repo, "chore: establish release history");
    git(repo, ["tag", "v0.2.0"]);
    commit(repo, "chore: prepare a preview");
    git(repo, ["tag", "v9.0.0-beta.1"]);
    commit(repo, "fix: correct a response", "This body has multiple lines.\n\nIt is still part of this one commit.");

    const result = runCli(repo, "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({ kind: "release", version: "0.2.1", bump: "patch" });
  });

  test("includes an older release-affecting commit when the newest commit is non-release-affecting", () => {
    const repo = setupRepo({ prefix: "release-version" });
    commit(repo, "chore: establish release history");
    git(repo, ["tag", "v1.2.3"]);
    commit(repo, "feat: add reports");
    commit(repo, "docs: clarify reports");

    const result = runCli(repo, "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({ kind: "release", version: "1.3.0", bump: "minor" });
  });

  test("allows a strictly newer stable explicit version without release-affecting commits", () => {
    const repo = setupRepo({ prefix: "release-version" });
    commit(repo, "chore: establish release history");
    git(repo, ["tag", "v1.2.3"]);
    commit(repo, "docs: clarify install");

    const result = runCli(repo, "--json", "--version", "1.3.0");

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({ kind: "release", version: "1.3.0", bump: "minor" });
  });

  test("allows only a greater explicit build-metadata version", () => {
    const repo = setupRepo({ prefix: "release-version" });
    commit(repo, "chore: establish release history");
    git(repo, ["tag", "v1.2.3+old"]);

    const greater = runCli(repo, "--json", "--version", "1.2.4+new");
    expect(greater.exitCode).toBe(0);
    expect(greater.stderr.toString()).toBe("");
    expect(JSON.parse(greater.stdout.toString())).toEqual({ kind: "release", version: "1.2.4+new", bump: "patch" });

    const equalPrecedence = runCli(repo, "--json", "--version", "1.2.3+new");
    expect(equalPrecedence.exitCode).not.toBe(0);
    expect(equalPrecedence.stdout.toString()).toBe("");
    expect(equalPrecedence.stderr.toString()).not.toBe("");
  });

  test("uses the greatest stable tag by SemVer precedence, including build metadata", () => {
    const repo = setupRepo({ prefix: "release-version" });
    commit(repo, "chore: establish release history");
    git(repo, ["tag", "v1.2.3"]);
    commit(repo, "chore: establish the next baseline");
    git(repo, ["tag", "v1.3.0"]);
    commit(repo, "chore: establish the greatest baseline");
    git(repo, ["tag", "v1.4.0+build.2"]);
    commit(repo, "fix: correct a response");

    const result = runCli(repo, "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({ kind: "release", version: "1.4.1", bump: "patch" });
  });

  test("emits the no-op recommendation as JSON", () => {
    const repo = setupRepo({ prefix: "release-version" });
    commit(repo, "chore: establish release history");
    git(repo, ["tag", "v1.2.3"]);
    commit(repo, "docs: clarify install");

    const result = runCli(repo, "--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({ kind: "none" });
  });

  test("rejects prerelease and non-increasing explicit versions without writing JSON", () => {
    const repo = setupRepo({ prefix: "release-version" });
    commit(repo, "chore: establish release history");
    git(repo, ["tag", "v1.2.3"]);

    for (const version of ["1.2.3-beta.1", "1.2.3", "1.2.2"]) {
      const result = runCli(repo, "--json", "--version", version);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).not.toBe("");
    }
  });

  test("reports malformed arguments and a missing stable tag on stderr", () => {
    const repo = setupRepo({ prefix: "release-version" });

    const malformed = runCli(repo, "--unexpected");
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stdout.toString()).toBe("");
    expect(malformed.stderr.toString()).not.toBe("");

    const missingTag = runCli(repo, "--json");
    expect(missingTag.exitCode).not.toBe(0);
    expect(missingTag.stdout.toString()).toBe("");
    expect(missingTag.stderr.toString()).not.toBe("");
  });
});
