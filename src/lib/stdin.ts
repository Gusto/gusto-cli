/**
 * Read a single access token piped on stdin - the `gh auth login --with-token` /
 * `docker login --password-stdin` pattern. A piped secret travels through an
 * in-memory pipe and never lands in argv, shell history, or `set -x`/audit logs,
 * unlike a `--token <value>` flag. See AINT-588.
 *
 * Consumes stdin to EOF and returns the first non-empty line, trimmed, or null
 * when nothing (or only whitespace) was piped. Only the first line is used: a
 * token never spans lines, and an embedded newline would corrupt the
 * `Authorization` header it ends up in.
 */
export async function readTokenFromStdin(input: AsyncIterable<unknown> = process.stdin): Promise<string | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const firstLine = Buffer.concat(chunks).toString("utf8").trim().split(/\r?\n/, 1)[0] ?? "";
  const token = firstLine.trim();
  return token.length > 0 ? token : null;
}
