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
