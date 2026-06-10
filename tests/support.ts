// Shared test helpers for the subprocess-based suites (install.test.ts, smoke.test.ts).

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
