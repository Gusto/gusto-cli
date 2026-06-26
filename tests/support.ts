// Shared test helpers for the subprocess-based suites (install.test.ts, smoke.test.ts).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Run {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn a command, capture stdout/stderr and the exit code. Pass `opts.stdin` to
 * feed the process stdin (e.g. a token piped to `--token-stdin`). */
export async function spawnCapture(
  cmd: string[],
  env: Record<string, string>,
  opts: { stdin?: string } = {},
): Promise<Run> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Write a completion script to a temp file and syntax-check it with `<shell> -n`, returning the
 * exit code (0 = parses cleanly). Shared by the generator unit tests and the binary smoke tests.
 * Callers guard on `Bun.which(shell)` first - on a runner without the shell this would ENOENT. */
export async function shellSyntaxCheck(shell: "bash" | "zsh", script: string): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), "gusto-completion-syntax-"));
  const file = path.join(dir, shell === "bash" ? "gusto.bash" : "_gusto");
  writeFileSync(file, script);
  const proc = Bun.spawn([shell, "-n", file], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  rmSync(dir, { recursive: true, force: true });
  return code;
}
