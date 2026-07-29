/** Helpers for the optimistic-concurrency `version` dance used when PUT/PATCHing versioned
 * Gusto resources - by `api request --auto-version` and by `putResourceWithVersion` (the address
 * update commands). Keeping them in one place stops the logic (and its edge cases) from drifting
 * between those two surfaces. */

import type { ApiClient } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import { isObject } from "./predicates.ts";
import { readString } from "./read-string.ts";
import type { CommandResult } from "./runner.ts";

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
 * `version`. The single source of truth for the GET-then-inject dance, run by `api request` when
 * `--auto-version` is passed and by `putResourceWithVersion` on every call. */
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

/** Prefix a failure from the version GET so it can't be misread as a failed write: the write was
 * never sent. The code and exit are left alone - a 403 `insufficient_scope` or a `network_error` on
 * the GET still needs its own classification. */
export function clarifyVersionReadFailure(result: CommandResult, path: string): CommandResult {
  if (result.ok) return result;
  return {
    ok: false,
    exitCode: result.exitCode,
    error: {
      ...result.error,
      message: `reading the current version from GET ${path} failed, so nothing was written: ${result.error.message}`,
    },
  };
}

/** Re-code the API's optimistic-concurrency rejection of a versioned write, so it doesn't collapse
 * into the `api_client_error` a bad payload also produces: the fix is to re-read the record, not to
 * change the request. Category-scoped, so an unrelated 409 surfaces as-is.
 *
 * The message covers both ways to earn one, because this also wraps plain `api request` writes: the
 * `version` sent was stale (the record moved under an auto-fetched version), or none was sent at all
 * (a versioned endpoint compares against nil and rejects - omitting the field is never a bypass). */
export function clarifyVersionConflict(result: CommandResult): CommandResult {
  if (result.ok || result.exitCode !== ExitCode.ApiClient) return result;

  // `details` is the raw server body, so `errors` can be any shape - a hash on a non-standard error
  // response, or an array with a null in it. Check the shape instead of asserting it: this runs inside
  // a catch block, so a TypeError here would escape as `internal_error` and lose the envelope that
  // catch exists to build. Widened past 409s (it gates on every ApiClient failure), so it has to hold
  // for arbitrary bodies from `api request`.
  const errors = isObject(result.error.details) ? result.error.details.errors : undefined;
  if (!Array.isArray(errors)) return result;
  if (!errors.some((e) => isObject(e) && e.category === "invalid_resource_version")) return result;

  return {
    ok: false,
    exitCode: ExitCode.Blocked,
    error: {
      code: "version_conflict",
      message:
        "the `version` sent with this update did not match the record's current version, or none was " +
        "sent, so the write was rejected and nothing was saved. GET the record for its current " +
        "`version` and retry with that value.",
      ...(result.error.details !== undefined ? { details: result.error.details } : {}),
      ...(result.error.request_id ? { request_id: result.error.request_id } : {}),
    },
  };
}
