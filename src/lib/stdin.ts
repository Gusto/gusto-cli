/**
 * Read a single access token piped on stdin - the `gh auth login --with-token` /
 * `docker login --password-stdin` pattern. A piped secret travels through an
 * in-memory pipe and never lands in argv, shell history, or `set -x`/audit logs,
 * unlike a `--token <value>` flag. See AINT-588.
 *
 * Consumes stdin to EOF and returns the trimmed contents, or null when nothing
 * (or only whitespace) was piped.
 */
export async function readTokenFromStdin(input: AsyncIterable<unknown> = process.stdin): Promise<string | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const token = Buffer.concat(chunks).toString("utf8").trim();
  return token.length > 0 ? token : null;
}
