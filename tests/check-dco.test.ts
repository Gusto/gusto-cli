import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dir, "..", "scripts", "check-dco.sh");

// Isolate git from the host's global/system config (signing hooks, templates).
const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...ISOLATED, ...extraEnv },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

function setupRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dco-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Jane Doe"]);
  git(dir, ["config", "user.email", "jane@example.com"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
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
});
