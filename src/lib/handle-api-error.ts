import { ApiError, type AuthContext, BlockedDestinationError, NetworkError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import { OAuthError } from "./oauth/endpoints.ts";
import { isGrantableScope } from "./oauth/required-scopes.ts";
import { parseScopes } from "./oauth/scopes.ts";
import { TokenRefreshFailedError, tokenRefreshFailedResult } from "./oauth/refresh-failure.ts";
import { errorExtras, type ScopeErrorCategory } from "./output.ts";
import { isObject } from "./predicates.ts";
import type { CommandResult } from "./runner.ts";

/** Every scope name a 403 body gives, in the same precedence `scopeErrorCategory` uses: the
 * `missing_scope_name` each of Gusto's own `missing_oauth_scopes` error entries carries in its
 * metadata (absent on older API responses), falling back to RFC 6750's top-level `scope`. */
function scopesFromBody(body: unknown): string[] {
  if (!isObject(body)) return [];
  const names = Array.isArray(body.errors)
    ? body.errors.filter(isScopeEntry).map((e) => (isObject(e.metadata) ? e.metadata.missing_scope_name : undefined))
    : [];
  const gusto = [...new Set(names.filter((n): n is string => typeof n === "string" && n.length > 0))];
  if (gusto.length > 0) return gusto;
  return typeof body.scope === "string" ? parseScopes(body.scope) : [];
}

function isScopeEntry(e: unknown): e is Record<string, unknown> {
  return isObject(e) && e.category === "missing_oauth_scopes";
}

/** Which scope-error shape a 403 body carries, if it indicates an OAuth scope problem (vs. a resource ACL).
 * Detects Gusto's `{ errors: [{ category: "missing_oauth_scopes" }] }` (the shape
 * this API returns, confirmed live) and the RFC 6750 `error: "insufficient_scope"`
 * standard. Deliberately narrow - fuzzier matches (e.g. a regex over a message)
 * risk catching unrelated 403s. */
function scopeErrorCategory(body: unknown): ScopeErrorCategory | undefined {
  if (!isObject(body)) return undefined;
  if (Array.isArray(body.errors) && body.errors.some(isScopeEntry)) {
    return "missing_oauth_scopes";
  }
  return body.error === "insufficient_scope" ? "insufficient_scope" : undefined;
}

/** Collect the human-readable messages out of an API error body, recursing into the nested
 * `errors[].errors[]` shape the API uses for record-level errors. The API owns the wording -
 * this only lifts it somewhere the caller will read, since `ApiError.message` is just the
 * request line. Returns `[]` for bodies that explain nothing. */
function serverMessages(body: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!isObject(node)) return;
    let text: string | undefined;
    if (typeof node.message === "string") text = node.message;
    else if (typeof node.error === "string") text = node.error;
    if (text !== undefined) {
      // Keep `error_key`: it names the offending field, and the API reuses one message across
      // fields, so dropping it collapses a multi-field 422 to "can't be blank; can't be blank".
      found.push(typeof node.error_key === "string" ? `${node.error_key}: ${text}` : text);
    }
    if (!Array.isArray(node.errors)) return;
    for (const nested of node.errors) {
      // A bare string entry is the message itself. Only honored inside `errors` - a
      // whole-body string is an unparsed response (an HTML error page from a proxy,
      // say) and does not belong in `message`.
      if (typeof nested === "string") found.push(nested);
      else visit(nested);
    }
  };
  visit(body);
  return Array.from(new Set(found));
}

/** Report a 401 as authentication failure, with recovery based on the credential source. */
function credentialRejected(err: ApiError): CommandResult<never> {
  const { auth } = err;
  return {
    ok: false,
    exitCode: ExitCode.Auth,
    error: {
      code: "credential_rejected",
      message: `${rejectedCredential(auth)} (${err.message})`,
      ...(auth ? { environment: auth.environment } : {}),
      ...errorExtras(err),
    },
  };
}

/** Name the refused credential and the recovery available for that source. */
function rejectedCredential(auth: AuthContext | undefined): string {
  if (auth === undefined) {
    return "the credential this command used was rejected by the API. If it came from `gusto auth login`, sign in again; if it came from GUSTO_ACCESS_TOKEN or --token-stdin, that token is invalid or expired.";
  }
  const env = auth.environment;
  switch (auth.tokenSource) {
    case "session":
      // The refresh already replaced the token, so the "stale" framing below would be wrong.
      if (auth.refreshed) {
        return `the ${env} session was refreshed during this command, and the API rejected the replacement token too - it may have been minted for the wrong environment, or for a different audience or scope than this endpoint needs. Run \`gusto auth login --env ${env}\` to sign in again.`;
      }
      return `the stored ${env} session was rejected by the API - its access token is stale or was revoked. Run \`gusto auth login --env ${env}\` to sign in again; that mints a new grant and replaces the refresh token in that slot.`;
    case "env":
      return `the token in GUSTO_ACCESS_TOKEN was rejected by the API. It is invalid, expired, or issued for an environment other than ${env}.`;
    case "stdin":
      return `the token piped via --token-stdin was rejected by the API. It is invalid, expired, or issued for an environment other than ${env}.`;
    // The one case where the credential is seconds old and ours: the login exchange returned a token
    // and the immediate `token_info` read on it came back 401, so the server refused what it had just
    // issued. None of the advice above applies - there is no stored session yet (the save happens
    // after this read) and no caller-supplied token to go fix. Rerunning the login is the only action,
    // and unlike a rejected stored session it costs nothing, since no credential was persisted to
    // replace. Naming the endpoint matters here: a 401 from a *scoped* command in the same session
    // means something else entirely.
    case "login":
      return `the ${env} token just minted by \`gusto auth login\` was rejected by the API when reading /v1/token_info. The server refused a credential it minted moments earlier, so the sign-in did not complete and nothing was stored - run \`gusto auth login --env ${env}\` again.`;
  }
}

/** Scope recovery follows the credential source for the same reason a rejected credential does:
 * logging in can replace a stored session, but it cannot change an explicit token that will keep
 * winning on the next command. For a stored session it also depends on whether each named scope is
 * in the CLI's grant, since signing in again can't add one that isn't. */
function insufficientScopeMessage(scopes: readonly string[], auth: AuthContext | undefined): string {
  const needs = scopes.length > 0 ? ` (${scopes.join(", ")})` : "";
  const preamble = `your token is missing the OAuth scope${scopes.length > 1 ? "s" : ""}${needs} this command needs.`;
  const env = auth ? ` --env ${auth.environment}` : "";
  const feedback = 'you can tell Gusto what you need with `gusto feedback --message "<what you need>"`';
  switch (auth?.tokenSource) {
    case undefined:
    case "session":
    case "login": {
      if (scopes.length === 0) {
        return `${preamble} Run \`gusto auth whoami${env}\` to see which scopes your session is missing; signing in again with \`gusto auth login${env}\` may add it. If that doesn't help, ${feedback}.`;
      }
      const grantable = scopes.filter((s) => isGrantableScope(s));
      const ungrantable = scopes.filter((s) => !isGrantableScope(s));
      if (ungrantable.length === 0) {
        return `${preamble} Re-run \`gusto auth login${env}\` and grant ${pronoun(scopes)}; run \`gusto auth whoami${env}\` to see what you have.`;
      }
      const outside = `${ungrantable.join(", ")} ${ungrantable.length > 1 ? "aren't" : "isn't"} part of the CLI's OAuth grant`;
      if (grantable.length === 0) {
        return `${preamble} ${outside}, so signing in again won't add ${pronoun(ungrantable)} - ${feedback}.`;
      }
      return `${preamble} Signing in again with \`gusto auth login${env}\` can add ${grantable.join(", ")}, but ${outside}, so this command will still fail - ${feedback}.`;
    }
    case "env":
      return `${preamble} Replace GUSTO_ACCESS_TOKEN with a token that grants ${pronoun(scopes)}; run \`gusto auth whoami${env}\` to inspect the active token.`;
    case "stdin":
      return `${preamble} Pipe a token that grants ${pronoun(scopes)} via --token-stdin; pipe the same token to \`gusto auth whoami --token-stdin${env}\` to inspect it.`;
  }
}

function pronoun(scopes: readonly string[]): string {
  return scopes.length > 1 ? "them" : "it";
}

/** The body minus its scope entries, so an unrelated error sharing the 403 still reaches the caller.
 * The scope entries' prose is written for partners who own their app's scopes ("reach out to
 * developer@"), which a CLI user can't act on. */
function nonScopeDetails(body: unknown): { details?: { errors: unknown[] } } {
  if (!isObject(body) || !Array.isArray(body.errors)) return {};
  const others = body.errors.filter((e) => !isScopeEntry(e));
  return others.length > 0 ? { details: { errors: others } } : {};
}

export function toResult(err: unknown): CommandResult<never> {
  if (err instanceof TokenRefreshFailedError) return tokenRefreshFailedResult(err.cause, err.env);
  if (err instanceof ApiError) {
    if (err.status === 401) return credentialRejected(err);
    const category = err.status === 403 ? scopeErrorCategory(err.body) : undefined;
    if (category !== undefined) {
      const scopes = scopesFromBody(err.body);
      return {
        ok: false,
        exitCode: ExitCode.Auth,
        error: {
          code: "insufficient_scope",
          message: insufficientScopeMessage(scopes, err.auth),
          // Carried for the same reason every other auth failure carries it: scopes are granted per
          // credential, and the credential is per environment, so "which scopes do I have" has no
          // answer that isn't scoped to one. This case is older than the codes below and predates the
          // field, so it read as the exception to a rule it actually belongs to.
          ...(err.auth ? { environment: err.auth.environment } : {}),
          category,
          ...(scopes.length > 0 ? { missing_scopes: scopes } : {}),
          ...nonScopeDetails(err.body),
          ...(err.requestId ? { request_id: err.requestId } : {}),
        },
      };
    }
    // Lead with what the API said and keep the request line as a suffix. Unprefixed,
    // `err.message` is only "GET <url> -> 422", which buries the one actionable sentence
    // two levels deep in `details` where callers branching on the envelope won't see it.
    const explained = serverMessages(err.body);
    return {
      ok: false,
      exitCode: err.exitCode,
      error: {
        code: err.status >= 500 ? "api_server_error" : "api_client_error",
        message: explained.length > 0 ? `${explained.join("; ")} (${err.message})` : err.message,
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
      ...(base.error.environment !== undefined ? { environment: base.error.environment } : {}),
      details: {
        ...spec.completed,
        completed: Object.keys(spec.completed),
        failed: { domain: spec.failedDomain, error: base.error },
      },
    },
  };
}
