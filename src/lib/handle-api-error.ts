import { ApiError, BlockedDestinationError, NetworkError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import { OAuthError } from "./oauth/endpoints.ts";
import type { CommandResult } from "./runner.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorExtras(err: { body: unknown; requestId?: string }): { details?: unknown; request_id?: string } {
  return {
    ...(err.body !== undefined && err.body !== null ? { details: err.body } : {}),
    ...(err.requestId ? { request_id: err.requestId } : {}),
  };
}

/** Pull a scope name out of a 403 body when the server names one (RFC 6750 `scope`). */
function scopeFromBody(body: unknown): string | undefined {
  return isObject(body) && typeof body.scope === "string" ? body.scope : undefined;
}

/** True when a 403 body indicates an OAuth scope problem (vs. a resource ACL).
 * Detects Gusto's `{ errors: [{ category: "missing_oauth_scopes" }] }` (the shape
 * this API returns, confirmed live) and the RFC 6750 `error: "insufficient_scope"`
 * standard. Deliberately narrow - fuzzier matches (e.g. a regex over a message)
 * risk catching unrelated 403s. */
function isInsufficientScope(body: unknown): boolean {
  if (!isObject(body)) return false;
  if (Array.isArray(body.errors) && body.errors.some((e) => isObject(e) && e.category === "missing_oauth_scopes")) {
    return true;
  }
  return body.error === "insufficient_scope";
}

export function toResult(err: unknown): CommandResult<never> {
  if (err instanceof ApiError) {
    if (err.status === 403 && isInsufficientScope(err.body)) {
      const scope = scopeFromBody(err.body);
      const needs = scope ? ` (${scope})` : "";
      return {
        ok: false,
        exitCode: ExitCode.Auth,
        error: {
          code: "insufficient_scope",
          message: `your token is missing the OAuth scope${needs} this command needs. Re-run \`gusto auth login\` and grant it; run \`gusto auth whoami\` to see what you have.`,
          ...errorExtras(err),
        },
      };
    }
    return {
      ok: false,
      exitCode: err.exitCode,
      error: {
        code: err.status >= 500 ? "api_server_error" : "api_client_error",
        message: err.message,
        ...errorExtras(err),
      },
    };
  }
  if (err instanceof NetworkError) {
    return {
      ok: false,
      exitCode: err.exitCode,
      error: { code: "network_error", message: err.message },
    };
  }
  if (err instanceof BlockedDestinationError) {
    return {
      ok: false,
      exitCode: err.exitCode,
      error: { code: "blocked_destination", message: err.message },
    };
  }
  if (err instanceof OAuthError) {
    // OAuthError uses status 0 as a sentinel for fetch-level failures.
    if (err.status === 0) {
      return {
        ok: false,
        exitCode: ExitCode.Network,
        error: { code: "network_error", message: err.message },
      };
    }
    return {
      ok: false,
      exitCode: err.status >= 500 ? ExitCode.ApiServer : ExitCode.ApiClient,
      error: {
        code: err.status >= 500 ? "oauth_server_error" : "oauth_client_error",
        message: err.message,
        ...errorExtras(err),
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    exitCode: ExitCode.General,
    error: { code: "internal_error", message },
  };
}

/** The failure returned when a create succeeds (2xx) but the response carries no usable uuid, so a
 * follow-up call keyed on that uuid can't be made. A server-side contract violation, hence
 * `ExitCode.ApiServer`. Shared by every create-then-use flow (bank accounts, contractor
 * self-onboarding, ...) so the code/shape stays in lockstep; `details` echoes the raw response for
 * debugging, and `message` should name the resource and the recovery path. */
export function createdWithoutUuidError(spec: {
  code: string;
  message: string;
  details?: unknown;
}): CommandResult<never> {
  return {
    ok: false,
    exitCode: ExitCode.ApiServer,
    error: {
      code: spec.code,
      message: spec.message,
      ...(spec.details !== undefined ? { details: spec.details } : {}),
    },
  };
}

/** Envelope for a partial failure: one or more earlier steps succeeded, then a
 * follow-up step failed, leaving the caller in a known intermediate state worth
 * reporting (e.g. a bank account was created but its verification failed, or an
 * employee's job was created but its compensation update failed). A retry can
 * resume from the failed step instead of redoing the completed ones.
 *
 * The underlying error is classified by `toResult`, so the exit code and the
 * nested `error` envelope match every other failure path in the CLI: a
 * NetworkError exits `Network`, an ApiError keeps its status-derived code and
 * carries its response body under `error.details`, and so on. `message` is a
 * prefix - the underlying error message is appended. `completed` maps each
 * domain/step that succeeded to the data it produced; `details` echoes that
 * data, lists those domains under `completed`, and names the step that failed
 * (with its structured error) under `failed`. */
export function partialFailure(spec: {
  code: string;
  message: string;
  err: unknown;
  completed: Record<string, unknown>;
  failedDomain: string;
}): CommandResult<never> {
  const base = toResult(spec.err);
  if (base.ok) throw new Error("toResult must return a failure", { cause: spec.err });
  return {
    ok: false,
    exitCode: base.exitCode,
    error: {
      code: spec.code,
      message: `${spec.message}: ${base.error.message}`,
      details: {
        ...spec.completed,
        completed: Object.keys(spec.completed),
        failed: { domain: spec.failedDomain, error: base.error },
      },
    },
  };
}
