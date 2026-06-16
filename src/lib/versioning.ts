/** Helpers for the optimistic-concurrency `version` dance shared by the commands that
 * PUT/PATCH versioned Gusto resources (`api request --auto-version`, `company setup`,
 * `employee add`). Keeping them in one place stops the logic (and its edge cases) from
 * drifting between copies. */

/** Read a non-empty string field from an unknown object body. */
export function readString(body: unknown, key: string): string | undefined {
  if (typeof body === "object" && body !== null) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Inject `version` into a PUT/PATCH body unless the caller already supplied a valid one
 * (theirs always wins). The body is spread first so an absent or invalid (empty/non-string)
 * `version` key can't clobber the injected value. */
export function withVersion(body: Record<string, unknown>, version: string | undefined): Record<string, unknown> {
  if (version === undefined || readString(body, "version") !== undefined) return body;
  return { ...body, version };
}
