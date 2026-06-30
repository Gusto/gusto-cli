import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PREPARE_HOOK = path.join(REPO_ROOT, ".githooks", "prepare-commit-msg");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-hooks.sh");

const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...ISOLATED },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

function setupRepo(opts: { configureUser?: boolean } = { configureUser: true }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hooks-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  if (opts.configureUser) {
    git(dir, ["config", "user.name", "Jane Doe"]);
    git(dir, ["config", "user.email", "jane@example.com"]);
  }
  return dir;
}

function stageHookOnly(repo: string) {
  mkdirSync(path.join(repo, ".githooks"), { recursive: true });
  copyFileSync(PREPARE_HOOK, path.join(repo, ".githooks", "prepare-commit-msg"));
  git(repo, ["config", "core.hooksPath", ".githooks"]);
}

function lastCommitBody(repo: string): string {
  return git(repo, ["log", "-1", "--format=%B"]);
}

describe("prepare-commit-msg hook", () => {
  test("appends Signed-off-by when missing", () => {
    const repo = setupRepo();
    stageHookOnly(repo);
    git(repo, ["commit", "--allow-empty", "-m", "feature work"]);
    const body = lastCommitBody(repo);
    expect(body).toContain("feature work");
    expect(body).toMatch(/^Signed-off-by: Jane Doe <jane@example\.com>$/m);
  });

  test("does not double-append when -s already passed", () => {
    const repo = setupRepo();
    stageHookOnly(repo);
    git(repo, ["commit", "--allow-empty", "-s", "-m", "feature work"]);
    const body = lastCommitBody(repo);
    const matches = body.match(/^Signed-off-by:/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  test("does not double-append on amend with existing sign-off", () => {
    const repo = setupRepo();
    stageHookOnly(repo);
    git(repo, ["commit", "--allow-empty", "-s", "-m", "feature work"]);
    git(repo, ["commit", "--amend", "--allow-empty", "--no-edit"]);
    const body = lastCommitBody(repo);
    expect((body.match(/^Signed-off-by:/gm) ?? []).length).toBe(1);
  });

  test("skips with stderr warning when user.name and user.email are unset", () => {
    const repo = setupRepo({ configureUser: false });
    stageHookOnly(repo);
    // GIT_AUTHOR_*/GIT_COMMITTER_* supply the identity git needs to allow the commit, but
    // unlike `git -c user.name=...` they don't show up in `git config user.name` inside
    // the hook - which is exactly the scenario we want to test.
    const res = Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "no-config commit"], {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "",
        ...ISOLATED,
        GIT_AUTHOR_NAME: "author-env",
        GIT_AUTHOR_EMAIL: "author@env.test",
        GIT_COMMITTER_NAME: "committer-env",
        GIT_COMMITTER_EMAIL: "committer@env.test",
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toContain("auto sign-off skipped");
    expect(lastCommitBody(repo)).not.toMatch(/^Signed-off-by:/m);
  });

  test("preserves multi-line commit message content", () => {
    const repo = setupRepo();
    stageHookOnly(repo);
    git(repo, ["commit", "--allow-empty", "-m", "subject", "-m", "body line one\n\nbody line two"]);
    const body = lastCommitBody(repo);
    expect(body).toContain("subject");
    expect(body).toContain("body line one");
    expect(body).toContain("body line two");
    expect(body).toMatch(/^Signed-off-by:/m);
  });
});

describe("install-hooks.sh", () => {
  function runInstall(cwd: string) {
    return Bun.spawnSync(["sh", INSTALL_SCRIPT], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...ISOLATED },
    });
  }

  test("sets core.hooksPath to .githooks", () => {
    const repo = setupRepo();
    const res = runInstall(repo);
    expect(res.exitCode).toBe(0);
    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe(".githooks");
  });

  test("is idempotent and silent on a second run", () => {
    const repo = setupRepo();
    runInstall(repo);
    const second = runInstall(repo);
    expect(second.exitCode).toBe(0);
    // First run announces the change; the second should be quiet because nothing changed.
    expect(second.stdout.toString().trim()).toBe("");
  });

  test("exits 0 outside a git work tree without setting anything", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "no-git-"));
    const res = runInstall(dir);
    expect(res.exitCode).toBe(0);
  });

  test("end-to-end: install + commit without -s yields a signed-off commit", () => {
    const repo = setupRepo();
    stageHookOnly(repo); // copy the hook file in
    git(repo, ["config", "--unset", "core.hooksPath"]); // undo the manual wire-up; let the installer set it
    expect(runInstall(repo).exitCode).toBe(0);
    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe(".githooks");
    git(repo, ["commit", "--allow-empty", "-m", "feature work"]);
    expect(lastCommitBody(repo)).toMatch(/^Signed-off-by: Jane Doe <jane@example\.com>$/m);
  });
});
