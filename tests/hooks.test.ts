import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { cleanupTempDirs, git, ISOLATED, setupRepo, tempDir } from "./helpers/git";

afterEach(cleanupTempDirs);

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PREPARE_HOOK = path.join(REPO_ROOT, ".githooks", "prepare-commit-msg");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-hooks.sh");

function stageHookOnly(repo: string) {
  mkdirSync(path.join(repo, ".githooks"), { recursive: true });
  copyFileSync(PREPARE_HOOK, path.join(repo, ".githooks", "prepare-commit-msg"));
  git(repo, ["config", "core.hooksPath", ".githooks"]);
}

function lastCommitBody(repo: string): string {
  return git(repo, ["log", "-1", "--format=%B"]);
}

function commitWithoutUserConfig(repo: string, message: string) {
  // GIT_AUTHOR_*/GIT_COMMITTER_* satisfy git's identity requirement for the commit
  // but, unlike `git -c user.name=...`, don't appear in `git config user.name` inside
  // the hook - which is exactly how we exercise the hook's "config unset" branch.
  return Bun.spawnSync(["git", "commit", "--allow-empty", "-m", message], {
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
}

describe("prepare-commit-msg hook", () => {
  test("appends Signed-off-by when missing", () => {
    const repo = setupRepo({ prefix: "hooks" });
    stageHookOnly(repo);
    git(repo, ["commit", "--allow-empty", "-m", "feature work"]);
    const body = lastCommitBody(repo);
    expect(body).toContain("feature work");
    expect(body).toMatch(/^Signed-off-by: Jane Doe <jane@example\.com>$/m);
  });

  test("does not double-append when -s already passed", () => {
    const repo = setupRepo({ prefix: "hooks" });
    stageHookOnly(repo);
    git(repo, ["commit", "--allow-empty", "-s", "-m", "feature work"]);
    const body = lastCommitBody(repo);
    expect((body.match(/^Signed-off-by:/gm) ?? []).length).toBe(1);
  });

  test("does not double-append on amend with existing sign-off", () => {
    const repo = setupRepo({ prefix: "hooks" });
    stageHookOnly(repo);
    git(repo, ["commit", "--allow-empty", "-s", "-m", "feature work"]);
    git(repo, ["commit", "--amend", "--allow-empty", "--no-edit"]);
    expect((lastCommitBody(repo).match(/^Signed-off-by:/gm) ?? []).length).toBe(1);
  });

  test("skips with stderr warning when both user.name and user.email are unset", () => {
    const repo = setupRepo({ prefix: "hooks", configureUser: false });
    stageHookOnly(repo);
    const res = commitWithoutUserConfig(repo, "no-config commit");
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toContain("auto sign-off skipped");
    expect(lastCommitBody(repo)).not.toMatch(/^Signed-off-by:/m);
  });

  test("skips with stderr warning when only user.email is set (no user.name)", () => {
    const repo = setupRepo({ prefix: "hooks", configureUser: false });
    git(repo, ["config", "user.email", "partial@example.com"]);
    stageHookOnly(repo);
    const res = commitWithoutUserConfig(repo, "email-only commit");
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toContain("auto sign-off skipped");
    expect(lastCommitBody(repo)).not.toMatch(/^Signed-off-by:/m);
  });

  test("skips with stderr warning when only user.name is set (no user.email)", () => {
    const repo = setupRepo({ prefix: "hooks", configureUser: false });
    git(repo, ["config", "user.name", "Partial Person"]);
    stageHookOnly(repo);
    const res = commitWithoutUserConfig(repo, "name-only commit");
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toContain("auto sign-off skipped");
    expect(lastCommitBody(repo)).not.toMatch(/^Signed-off-by:/m);
  });

  test("preserves multi-line commit message content", () => {
    const repo = setupRepo({ prefix: "hooks" });
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
  function runInstall(cwd: string, extraEnv: Record<string, string> = {}) {
    return Bun.spawnSync(["sh", INSTALL_SCRIPT], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...ISOLATED, ...extraEnv },
    });
  }

  test("sets core.hooksPath to .githooks", () => {
    const repo = setupRepo({ prefix: "install" });
    const res = runInstall(repo);
    expect(res.exitCode).toBe(0);
    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe(".githooks");
  });

  test("is idempotent and silent on a second run", () => {
    const repo = setupRepo({ prefix: "install" });
    runInstall(repo);
    const second = runInstall(repo);
    expect(second.exitCode).toBe(0);
    // First run announces the change; the second should be quiet because nothing changed.
    expect(second.stdout.toString().trim()).toBe("");
  });

  test("leaves a pre-existing custom core.hooksPath untouched and warns", () => {
    const repo = setupRepo({ prefix: "install" });
    git(repo, ["config", "--local", "core.hooksPath", ".my-hooks"]);
    const res = runInstall(repo);
    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString()).toContain("already set to '.my-hooks'");
    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe(".my-hooks");
  });

  test("exits 0 outside a git work tree without setting anything", () => {
    const dir = tempDir("no-git");
    const res = runInstall(dir);
    expect(res.exitCode).toBe(0);
  });

  test("exits 0 when BUN_INSTALL_CACHE_DIR is set but cwd is not a git repo", () => {
    // The bun-install scenario: bun's postinstall step runs the script in a node_modules
    // checkout that has no .git of its own. Make sure the script no-ops cleanly instead
    // of failing the install.
    const dir = tempDir("bun-install");
    const res = runInstall(dir, { BUN_INSTALL_CACHE_DIR: "/tmp/bun-cache" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim()).toBe("");
  });

  test("does not hijack a parent repo when installed from a nested dir without its own .git", () => {
    // Consumer install: bun runs the postinstall inside node_modules/gusto-cli, which has
    // no .git of its own but sits under the consumer's repo. The script must bail rather
    // than walk up and rewrite the parent repo's core.hooksPath.
    const repo = setupRepo({ prefix: "consumer" });
    const nested = path.join(repo, "node_modules", "gusto-cli");
    mkdirSync(nested, { recursive: true });
    const res = runInstall(nested, { BUN_INSTALL_CACHE_DIR: "/tmp/bun-cache" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim()).toBe("");
    expect(git(repo, ["config", "--local", "--default", "", "--get", "core.hooksPath"])).toBe("");
  });

  test("end-to-end: install + commit without -s yields a signed-off commit", () => {
    const repo = setupRepo({ prefix: "install" });
    stageHookOnly(repo);
    git(repo, ["config", "--unset", "core.hooksPath"]); // undo the manual wire-up; let the installer set it
    expect(runInstall(repo).exitCode).toBe(0);
    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe(".githooks");
    git(repo, ["commit", "--allow-empty", "-m", "feature work"]);
    expect(lastCommitBody(repo)).toMatch(/^Signed-off-by: Jane Doe <jane@example\.com>$/m);
  });
});
