/**
 * Read a single access token piped on stdin - the `gh auth login --with-token` /
 * `docker login --password-stdin` pattern. A piped secret travels through an
 * in-memory pipe and never lands in argv, shell history, or `set -x`/audit logs,
 * unlike a `--token <value>` flag.
 *
 * Consumes stdin to EOF and returns the first non-empty line, trimmed, or null
 * when nothing (or only whitespace) was piped. Only the first line is used: a
 * token never spans lines, and an embedded newline would corrupt the
 * `Authorization` header it ends up in.
 *
 * On an interactive terminal there's nothing to read - `for await` would block on
 * stdin until EOF (Ctrl-D), a hang the command runner can't catch. Fast-fail to
 * null instead; this is an automation-first CLI. Piped/redirected stdin is not a
 * TTY, so the normal read path runs there.
 */
export async function readTokenFromStdin(
  input: AsyncIterable<Buffer | string> = process.stdin,
): Promise<string | null> {
  if ((input as { isTTY?: boolean }).isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const firstLine = Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/, 1)[0] ?? "";
  const token = firstLine.trim();
  return token.length > 0 ? token : null;
}
