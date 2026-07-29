/** Helpers for the optimistic-concurrency `version` dance used when PUT/PATCHing versioned
 * Gusto resources (`api request --auto-version`). Keeping them in one place stops the logic
 * (and its edge cases) from drifting between copies. */

import type { ApiClient } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
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
 * `--auto-version` is passed. */
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

/** The failure for a version GET that succeeded (2xx) but carried no top-level `version`, so the
 * write keyed on it can't be sent. `recovery` names the surface-specific way to supply a version by
 * hand. Shared so `putResourceWithVersion` and `api request --auto-version` can't drift on the code,
 * exit, or wording - the escape hatch has returned this since before the address commands existed.
 *
 * Unreachable for the address commands: zenpayroll's `home_addresses`/`work_addresses` show
 * serializers always render `version` (via `HomeAddressFacade.version_for` -> `Versionable
 * .version_hash`, an MD5 digest that is never nil), and a bad uuid is a 403/404 rather than a 2xx
 * with the field missing. It stays because `getAndInjectVersion`'s result type forces the branch,
 * and because the escape hatch can hit it for real - `GET /v1/companies/{uuid}/payrolls/{uuid}`
 * renders no top-level `version` (the token lives on `employee_compensations[]`), so
 * `api request PUT ... --auto-version` against a payroll lands here. */
export function versionUnresolvedError(path: string, recovery: string): CommandResult<never> {
  return {
    ok: false,
    exitCode: ExitCode.Validation,
    error: {
      code: "version_unresolved",
      message: `no \`version\` field in the GET ${path} response; ${recovery}`,
    },
  };
}

/** Prefix a failure from the version GET so it can't be misread as a failed write: the write was
 * never sent, and the caller's state is untouched. The code and exit are left alone on purpose - a
 * 403 `insufficient_scope` or a `network_error` on the GET still needs its own classification, and
 * only the message says which leg of the dance failed. */
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

/** Re-code the API's optimistic-concurrency rejection of a versioned write. A 409 tagged
 * `invalid_resource_version` means the resource changed between the version GET and the write - the
 * exact race the version dance exists to catch - so it earns its own code and a `Blocked` exit
 * instead of collapsing into the `api_client_error` a bad payload would also produce: the fix is to
 * re-read and retry, not to change the request. Detection is narrow (the category the API tags these
 * with) so an unrelated 409 still surfaces as-is. */
export function clarifyVersionConflict(result: CommandResult): CommandResult {
  if (result.ok || result.exitCode !== ExitCode.ApiClient) return result;

  const errors = (result.error.details as { errors?: { category?: string }[] } | undefined)?.errors;
  if (!errors?.some((e) => e.category === "invalid_resource_version")) return result;

  return {
    ok: false,
    exitCode: ExitCode.Blocked,
    error: {
      code: "version_conflict",
      message:
        "the record changed between reading its version and sending this update, so the write was " +
        "rejected and nothing was saved. Re-run to pick up the current version, or pass the new " +
        "version explicitly.",
      ...(result.error.details !== undefined ? { details: result.error.details } : {}),
      ...(result.error.request_id ? { request_id: result.error.request_id } : {}),
    },
  };
}
