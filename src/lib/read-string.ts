/** Read a non-empty string field off an unknown response body, or undefined. Shared by the command
 * flows that pull ids off API JSON (e.g. a created resource's `uuid`, a record's `version`) before
 * using them in a follow-up request path or body. */
export function readString(body: unknown, key: string): string | undefined {
  if (typeof body === "object" && body !== null) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
