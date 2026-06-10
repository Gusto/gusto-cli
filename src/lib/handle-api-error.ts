import { ApiError, NetworkError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";

/** Pull a scope name out of a 403 body when the server names one. */
function scopeFromBody(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.scope === "string") return b.scope;
    if (Array.isArray(b.required_scopes) && typeof b.required_scopes[0] === "string") {
      return b.required_scopes.join(", ");
    }
  }
  return undefined;
}

/** True when a 403 body indicates an OAuth scope problem (vs. a resource ACL). */
function isInsufficientScope(body: unknown): boolean {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b.error === "insufficient_scope") return true;
    if (typeof b.error_description === "string" && /scope/i.test(b.error_description)) return true;
    if (typeof b.scope === "string" || Array.isArray(b.required_scopes)) return true;
  }
  return false;
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
          ...(err.body !== undefined && err.body !== null ? { details: err.body } : {}),
          ...(err.requestId ? { request_id: err.requestId } : {}),
        },
      };
    }
    return {
      ok: false,
      exitCode: err.exitCode,
      error: {
        code: err.status >= 500 ? "api_server_error" : "api_client_error",
        message: err.message,
        ...(err.body !== undefined && err.body !== null ? { details: err.body } : {}),
        ...(err.requestId ? { request_id: err.requestId } : {}),
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
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    exitCode: ExitCode.General,
    error: { code: "internal_error", message },
  };
}
