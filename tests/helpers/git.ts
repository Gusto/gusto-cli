import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate git from the host's global/system config (signing hooks, templates) so
// every test gets a clean slate. Spawn git with these set on the env.
export const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

export function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...ISOLATED, ...extraEnv },
  });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

export interface RepoOpts {
  configureUser?: boolean;
  prefix?: string;
}

/** Create a fresh temp git repo. `configureUser` defaults to true; pass false to
 * leave user.name/user.email unset (e.g. to exercise hook fallback paths). */
export function setupRepo(opts: RepoOpts = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), `${opts.prefix ?? "gusto-cli-test"}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  if (opts.configureUser ?? true) {
    git(dir, ["config", "user.name", "Jane Doe"]);
    git(dir, ["config", "user.email", "jane@example.com"]);
  }
  return dir;
}
