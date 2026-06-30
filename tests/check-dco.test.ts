import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { cleanupTempDirs, git, setupRepo as setupRepoHelper } from "./helpers/git";

const SCRIPT = path.resolve(import.meta.dir, "..", "scripts", "check-dco.sh");

afterEach(cleanupTempDirs);

function setupRepo(): string {
  return setupRepoHelper({ prefix: "dco" });
}

interface CommitOpts {
  signoff?: boolean;
  authorName?: string;
  authorEmail?: string;
}

function commit(cwd: string, message: string, opts: CommitOpts = {}): string {
  const args = ["commit", "-q", "--allow-empty"];
  if (opts.signoff) args.push("-s");
  args.push("-m", message);
  const env: Record<string, string> = {};
  if (opts.authorName) env.GIT_AUTHOR_NAME = opts.authorName;
  if (opts.authorEmail) env.GIT_AUTHOR_EMAIL = opts.authorEmail;
  git(cwd, args, env);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function runCheck(cwd: string, base: string, head: string) {
  const res = Bun.spawnSync(["bash", SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH ?? "", BASE: base, HEAD: head },
  });
  return { exitCode: res.exitCode, output: res.stdout.toString() + res.stderr.toString() };
}

describe("check-dco.sh", () => {
  test("passes when every commit in range is signed off", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    const head = commit(repo, "feature", { signoff: true });
    const r = runCheck(repo, base, head);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("ok:");
  });

  test("fails when a commit lacks a sign-off", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    const head = commit(repo, "unsigned feature");
    const r = runCheck(repo, base, head);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("MISSING");
  });

  test("exempts bot authors", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    const head = commit(repo, "bump deps", {
      authorName: "dependabot[bot]",
      authorEmail: "49699333+dependabot[bot]@users.noreply.github.com",
    });
    const r = runCheck(repo, base, head);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("skip bot:");
  });

  test("fails closed on a bad base ref instead of passing silently", () => {
    const repo = setupRepo();
    commit(repo, "base");
    const head = commit(repo, "feature", { signoff: true });
    const r = runCheck(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", head);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).not.toContain("ok:");
  });

  test("fails when BASE or HEAD is empty", () => {
    const repo = setupRepo();
    const r = runCheck(repo, "", "");
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("range");
  });

  test("fails when the range is empty (BASE equals HEAD)", () => {
    const repo = setupRepo();
    commit(repo, "base");
    const head = commit(repo, "feature", { signoff: true });
    const r = runCheck(repo, head, head);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("No commits");
  });

  test("fails when any commit in a multi-commit range is unsigned", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    commit(repo, "signed one", { signoff: true });
    commit(repo, "unsigned two");
    const head = commit(repo, "signed three", { signoff: true });
    const r = runCheck(repo, base, head);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("MISSING");
    expect(r.output).toContain("ok:");
  });

  test("fails when the Signed-off-by email does not match the author", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    // Author defaults to jane@example.com; the sign-off names someone else.
    git(repo, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "feature",
      "-m",
      "Signed-off-by: Imposter <imposter@example.com>",
    ]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const r = runCheck(repo, base, head);
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("MISSING");
  });

  test("exempts the *bot@users.noreply.github.com pattern", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    const head = commit(repo, "automated bump", {
      authorName: "Build Bot",
      authorEmail: "buildbot@users.noreply.github.com",
    });
    const r = runCheck(repo, base, head);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("skip bot:");
  });

  test("fails closed on a bad HEAD ref instead of passing silently", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    commit(repo, "feature", { signoff: true });
    const r = runCheck(repo, base, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(r.exitCode).not.toBe(0);
    expect(r.output).not.toContain("ok:");
  });

  test("ignores merge commits (--no-merges)", () => {
    const repo = setupRepo();
    const base = commit(repo, "base", { signoff: true });
    git(repo, ["checkout", "-q", "-b", "side"]);
    commit(repo, "side work", { signoff: true });
    git(repo, ["checkout", "-q", "main"]);
    // --no-ff forces a merge commit, which git creates without a sign-off.
    git(repo, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const r = runCheck(repo, base, head);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("side work");
  });

  test("validates each commit against its own author", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    git(
      repo,
      ["commit", "-q", "--allow-empty", "-m", "alice change", "-m", "Signed-off-by: Alice <alice@example.com>"],
      {
        GIT_AUTHOR_NAME: "Alice",
        GIT_AUTHOR_EMAIL: "alice@example.com",
      },
    );
    git(repo, ["commit", "-q", "--allow-empty", "-m", "bob change", "-m", "Signed-off-by: Bob <bob@example.com>"], {
      GIT_AUTHOR_NAME: "Bob",
      GIT_AUTHOR_EMAIL: "bob@example.com",
    });
    const head = git(repo, ["rev-parse", "HEAD"]);
    const r = runCheck(repo, base, head);
    expect(r.exitCode).toBe(0);
  });

  test("passes when one of several sign-offs matches the author", () => {
    const repo = setupRepo();
    const base = commit(repo, "base");
    // Author is jane@example.com; one of the two sign-offs matches her.
    git(repo, [
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "co-developed change",
      "-m",
      "Signed-off-by: Other <other@example.com>\nSigned-off-by: Jane Doe <jane@example.com>",
    ]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const r = runCheck(repo, base, head);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("ok:");
  });
});
