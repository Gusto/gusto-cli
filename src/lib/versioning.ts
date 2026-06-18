/** Helpers for the optimistic-concurrency `version` dance shared by the commands that
 * PUT/PATCH versioned Gusto resources (`api request --auto-version`, `company setup`,
 * `employee add`). Keeping them in one place stops the logic (and its edge cases) from
 * drifting between copies. */

import type { ApiClient } from "./api-client.ts";
import { readString } from "./read-string.ts";

/** Inject `version` into a PUT/PATCH body unless the caller already supplied a valid one
 * (theirs always wins). The body is spread first so an absent or invalid (empty/non-string)
 * `version` key can't clobber the injected value. */
export function withVersion(body: Record<string, unknown>, version: string | undefined): Record<string, unknown> {
  if (version === undefined || readString(body, "version") !== undefined) return body;
  return { ...body, version };
}

/** GET `path` to read the resource's current `version` and inject it into `body`, unless the
 * caller already supplied a valid one (theirs always wins, so the GET is skipped). Returns the
 * version-injected body, or `version_unresolved` when the GET response carried no top-level
 * `version`. The single source of truth for the GET-then-inject dance: `api request` runs it when
 * `--auto-version` is passed, `employee add`'s `putVersioned` runs it unconditionally. */
export async function getAndInjectVersion(
  client: Pick<ApiClient, "get">,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: "version_unresolved" }> {
  if (readString(body, "version") !== undefined) return { ok: true, body };
  const current = await client.get(path);
  const version = readString(current.body, "version");
  if (version === undefined) return { ok: false, reason: "version_unresolved" };
  return { ok: true, body: withVersion(body, version) };
}
