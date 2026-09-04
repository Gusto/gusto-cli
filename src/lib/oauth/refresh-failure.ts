import { ExitCode } from "../exit-codes.ts";
import type { Environment } from "../global-flags.ts";
import { type EnvelopeError, errorExtras } from "../output.ts";
import { isObject } from "../predicates.ts";
import type { CommandResult } from "../runner.ts";
import { OAuthError } from "./endpoints.ts";
import { credentialsFile } from "./token-store.ts";

/** Thrown when a 401-triggered ("reactive") refresh is itself rejected by the token endpoint.
 * Reported the same way a pre-request ("proactive") refresh failure is, so the two can't drift on
 * wording. */
export class TokenRefreshFailedError extends Error {
  constructor(
    readonly cause: OAuthError,
    readonly env: Environment,
  ) {
    super(`refreshing the ${env} session failed: ${cause.message}`);
    this.name = "TokenRefreshFailedError";
  }
}

/** Why the token endpoint refused, as it described it. `OAuthError.message` is only the request line
 * ("/v1/mcp/oauth/token -> 400"), which names a status but not a cause; RFC 6749 puts the cause in
 * the body. Lifted into the message because that is what a caller reads first - `details` still
 * carries the whole body. */
function oauthReason(err: OAuthError): string {
  if (!isObject(err.body)) return err.message;
  const { error, error_description: description } = err.body;
  const parts = [error, description].filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.length > 0 ? `${parts.join(": ")} - ${err.message}` : err.message;
}

/** Where the failing lookup read from, named so an agent doesn't have to infer it. */
export function slotDescription(env: Environment): string {
  return `the [${env}] slot of ${credentialsFile()}`;
}

/** Classify refresh failures by recovery: retry, replace the grant, replace the client
 * registration, fix the request, or avoid guessing. */
type RefreshFailureReason = "transient" | "grant_rejected" | "client_rejected" | "request_rejected" | "unknown";

function refreshFailureReason(err: OAuthError): RefreshFailureReason {
  if (isObject(err.body)) {
    switch (err.body.error) {
      case "invalid_grant":
        return "grant_rejected";
      case "invalid_client":
      case "unauthorized_client":
        return "client_rejected";
      case "invalid_request":
      case "unsupported_grant_type":
      case "invalid_scope":
        return "request_rejected";
      case "server_error":
      case "temporarily_unavailable":
        return "transient";
    }
  }
  if (err.status === 0 || err.status >= 500) return "transient";
  return "unknown";
}

/** Recommend the least expensive recovery supported by the server's reason. A rejected client
 * registration requires logout before login because login otherwise reuses the stored registration. */
export function refreshFailureMessage(err: OAuthError, env: Environment, slot: string): string {
  const preamble = `refreshing the ${env} session failed (${oauthReason(err)}).`;
  switch (refreshFailureReason(err)) {
    case "grant_rejected":
      return `${preamble} The server rejected the refresh token in ${slot} as invalid, expired, or revoked, so a retry fails the same way. Run \`gusto auth login --env ${env}\` to sign in again - that replaces the refresh token, which is already dead.`;
    case "client_rejected":
      return `${preamble} The server rejected this CLI's client registration in ${slot}, not the refresh token, so a retry fails the same way. \`gusto auth login\` reuses that registration and would fail too - clear the slot first with \`gusto auth logout --env ${env}\`, then \`gusto auth login --env ${env}\` to register again. Nothing usable is lost: the credentials in that slot are what just got refused.`;
    case "request_rejected":
      return `${preamble} The token endpoint rejected the refresh request as invalid or unsupported, so the same request will fail the same way. The credentials in ${slot} are still on file; check \`gusto upgrade --dry-run\`, and report this error if the CLI is current.`;
    case "transient":
      return `${preamble} The refresh token in ${slot} is still on file and was not replaced - retry the command first. Only run \`gusto auth login --env ${env}\` if the retry fails too, since logging in replaces that refresh token.`;
    case "unknown":
      return `${preamble} The token endpoint did not identify a recovery, so the CLI will not guess that a retry or login can fix it. The credentials in ${slot} are still on file; check \`gusto upgrade --dry-run\`, and report this error if the CLI is current.`;
  }
}

/** Build the `token_refresh_failed` error fields shared by the proactive (pre-request) and reactive
 * (401-triggered) refresh paths, so a caller can't report one differently from the other. */
export function tokenRefreshFailedError(err: OAuthError, env: Environment): EnvelopeError {
  return {
    code: "token_refresh_failed",
    message: refreshFailureMessage(err, env, slotDescription(env)),
    environment: env,
    ...errorExtras(err),
  };
}

/** Split from `tokenRefreshFailedError` so `sessionFailure` can merge in its other-environment hint
 * before wrapping the fields into a result - `toResult` has no such hint to add. */
export function tokenRefreshFailedResult(err: OAuthError, env: Environment): CommandResult<never> {
  return { ok: false, exitCode: ExitCode.Auth, error: tokenRefreshFailedError(err, env) };
}
