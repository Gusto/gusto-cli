import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTempDirs, git, ISOLATED, setupRepo, tempDir } from "./helpers/git";

afterEach(cleanupTempDirs);

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PREPARE_HOOK = path.join(REPO_ROOT, ".githooks", "prepare-commit-msg");
const COMMIT_MSG_HOOK = path.join(REPO_ROOT, ".githooks", "commit-msg");
const CHECK_MESSAGE_SCRIPT = path.join(REPO_ROOT, "scripts", "check-commit-message.sh");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-hooks.sh");

function stageHookOnly(repo: string) {
  mkdirSync(path.join(repo, ".githooks"), { recursive: true });
  copyFileSync(PREPARE_HOOK, path.join(repo, ".githooks", "prepare-commit-msg"));
  git(repo, ["config", "core.hooksPath", ".githooks"]);
}

function lastCommitBody(repo: string): string {
  return git(repo, ["log", "-1", "--format=%B"]);
}

function runMessageCheck(message: string) {
  const messageFile = path.join(tempDir("commit-message"), "COMMIT_EDITMSG");
  writeFileSync(messageFile, message);
  return Bun.spawnSync(["sh", CHECK_MESSAGE_SCRIPT, messageFile], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "", ...ISOLATED },
  });
}

function runMessageCheckWithoutGit(message: string) {
  const source = tempDir("source-artifact");
  const messageFile = path.join(source, "PR_TITLE");
  copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(source, "package.json"));
  copyFileSync(path.join(REPO_ROOT, "commitlint.config.ts"), path.join(source, "commitlint.config.ts"));
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(source, "node_modules"), "dir");
  writeFileSync(messageFile, message);
  return Bun.spawnSync(["sh", CHECK_MESSAGE_SCRIPT, messageFile], {
    cwd: source,
    env: { PATH: process.env.PATH ?? "", ...ISOLATED },
  });
}

function stageCommitValidationHooks(repo: string) {
  const hooks = path.join(repo, ".githooks");
  const scripts = path.join(repo, "scripts");
  mkdirSync(hooks, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  copyFileSync(PREPARE_HOOK, path.join(hooks, "prepare-commit-msg"));
  if (existsSync(COMMIT_MSG_HOOK)) copyFileSync(COMMIT_MSG_HOOK, path.join(hooks, "commit-msg"));
  if (existsSync(CHECK_MESSAGE_SCRIPT))
    copyFileSync(CHECK_MESSAGE_SCRIPT, path.join(scripts, "check-commit-message.sh"));
  if (existsSync(path.join(REPO_ROOT, "commitlint.config.ts"))) {
    copyFileSync(path.join(REPO_ROOT, "commitlint.config.ts"), path.join(repo, "commitlint.config.ts"));
  }
  copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(repo, "package.json"));
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(repo, "node_modules"), "dir");
  git(repo, ["config", "core.hooksPath", ".githooks"]);
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

describe("check-commit-message.sh", () => {
  test("accepts a PR title from an extracted source artifact without Git metadata", () => {
    const result = runMessageCheckWithoutGit("ci: validate pull request titles\n");
    expect(result.exitCode).toBe(0);
  });

  test("accepts every allowed conventional commit type", () => {
    const allowedTypes = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];

    for (const type of allowedTypes) {
      expect(runMessageCheck(`${type}: describe the change\n`).exitCode).toBe(0);
    }
  });

  test("accepts lowercase kebab-case scopes", () => {
    expect(runMessageCheck("feat(auth-session): add login recovery\n").exitCode).toBe(0);
  });

  test("accepts a breaking change footer", () => {
    expect(runMessageCheck("feat!: change output schema\n\nBREAKING CHANGE: new envelope\n").exitCode).toBe(0);
  });

  test("accepts a DCO trailer appended by prepare-commit-msg", () => {
    expect(
      runMessageCheck("feat(auth): add login recovery\n\nSigned-off-by: Jane Doe <jane@example.com>\n").exitCode,
    ).toBe(0);
  });

  test("accepts merge-generated commit messages", () => {
    expect(runMessageCheck("Merge branch 'main' into feature\n").exitCode).toBe(0);
  });

  test("accepts revert-generated commit messages", () => {
    expect(runMessageCheck('Revert "feat(auth): add login recovery"\n\nThis reverts commit abcdef.\n').exitCode).toBe(
      0,
    );
  });

  test("rejects a subject without a conventional commit type", () => {
    expect(runMessageCheck("Add login recovery\n").exitCode).not.toBe(0);
  });

  test("rejects uppercase scopes", () => {
    expect(runMessageCheck("feat(Auth): add login recovery\n").exitCode).not.toBe(0);
  });

  test("rejects internal-ticket-shaped scopes", () => {
    expect(runMessageCheck("feat(INTERNAL-123): add login recovery\n").exitCode).not.toBe(0);
  });

  test("rejects ticket-shaped references in a conventional subject", () => {
    const result = runMessageCheck("feat: replace INTERNAL-123 behavior\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("commit subject/scope must not contain an internal ticket key");
  });

  test("rejects empty subjects", () => {
    expect(runMessageCheck("feat(auth): \n").exitCode).not.toBe(0);
  });

  test("rejects headers longer than 100 characters", () => {
    expect(runMessageCheck(`feat: ${"a".repeat(95)}\n`).exitCode).not.toBe(0);
  });

  test("rejects an invalid commit after prepare-commit-msg adds the DCO trailer", () => {
    const repo = setupRepo({ prefix: "commit-validation" });
    stageCommitValidationHooks(repo);

    const invalid = Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "Add login recovery"], {
      cwd: repo,
      env: { PATH: process.env.PATH ?? "", ...ISOLATED },
    });
    expect(invalid.exitCode).not.toBe(0);

    git(repo, ["commit", "--allow-empty", "-m", "feat(auth): add login recovery"]);
    expect(lastCommitBody(repo)).toMatch(/^Signed-off-by: Jane Doe <jane@example\.com>$/m);
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
