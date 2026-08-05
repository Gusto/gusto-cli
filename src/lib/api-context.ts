import { ApiClient, stderrRequestObserver } from "./api-client.ts";
import { confirmationGate } from "./confirm.ts";
import { defaultEnv, getAccessToken, getCompanyUuid, resolveApiVersion, resolveBaseUrl } from "./env.ts";
import { ExitCode } from "./exit-codes.ts";
import type { Environment, GlobalFlags } from "./global-flags.ts";
import { toResult } from "./handle-api-error.ts";
import { oauthHttp } from "./oauth/context.ts";
import type { OAuthError, OAuthHttpOptions } from "./oauth/endpoints.ts";
import { type SessionOutcome, resolveSessionToken } from "./oauth/session.ts";
import { type TokenStore, credentialsFile, resolveStore } from "./oauth/token-store.ts";
import type { EnvelopeError } from "./output.ts";
import { isObject } from "./predicates.ts";
import type { CommandResult } from "./runner.ts";
import { readTokenFromStdin } from "./stdin.ts";

/** Reads a single piped access token (or null if none). Injectable for tests. */
export type StdinReader = () => Promise<string | null>;

/** Which credential supplied the resolved access token, in precedence order. */
export type TokenSource = "stdin" | "env" | "session";

interface ApiContextBase {
  client: ApiClient;
  baseUrl: string;
  tokenSource: TokenSource;
}

export type ApiContext =
  | (ApiContextBase & { hasCompany: true; companyUuid: string })
  | (ApiContextBase & { hasCompany: false });

export type CompanyApiContext = Extract<ApiContext, { hasCompany: true }>;

export interface AuthOpts {
  /** Whether --token-stdin was passed: read one token from stdin as a last resort. */
  tokenStdin?: boolean;
  /** Override the stdin read (tests). Defaults to reading real stdin. */
  readStdin?: StdinReader;
  store?: TokenStore;
  http?: OAuthHttpOptions;
  now?: () => number;
}

export interface ApiContextOpts extends AuthOpts {
  requireCompany?: boolean;
  companyOverride?: string;
}

/** Build an ApiClient with the shared conventions REST commands + MCP tool calls share:
 * `apiVersion` and (when `--verbose` is on) a stderr request observer. Extracted so those two
 * surfaces can't drift on which client options they attach. `stderr` is injectable so tests
 * capture the log stream instead of writing to the real process stderr.
 *
 * Not routed through: `oauthApiClient` in `oauth/context.ts` (its own bearer client for
 * `token_info` during login) - so `auth login --verbose` won't emit the token_info line. Tracked
 * as a follow-up. */
export function buildApiClient(
  globals: GlobalFlags,
  opts: { baseUrl: string; token: string; stderr?: NodeJS.WritableStream },
): ApiClient {
  return new ApiClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    apiVersion: resolveApiVersion(),
    observer: globals.verbose ? stderrRequestObserver(opts.stderr ?? process.stderr) : undefined,
  });
}

type Resolved<T> = { ok: true; ctx: T } | { ok: false; result: CommandResult<never> };

export type ResolvedToken =
  | { ok: true; token: string; source: TokenSource }
  | { ok: false; result: CommandResult<never> };

/** Resolve the access token using the precedence every CLI converges on - an
 * explicit token always overrides the stored login: --token-stdin (piped) >
 * GUSTO_ACCESS_TOKEN env > stored login session. Once an explicit token is
 * supplied we never fall back to the session, even if that token is invalid, so
 * a typo'd secret surfaces the real auth error instead of silently running as the
 * logged-in identity. The session is only loaded when no explicit
 * token is present, so a bad GUSTO_ACCESS_TOKEN can't be masked by an on-disk
 * session refresh. An empty pipe under `--token-stdin` is treated as an explicit
 * credential choice that failed, not a falls-through-to-other-sources case - same
 * silent-identity-drift hazard as a bad env token. `source` tells callers which
 * credential won. */
export async function resolveAuthToken(globals: GlobalFlags, opts: AuthOpts): Promise<ResolvedToken> {
  if (opts.tokenStdin) {
    const piped = await (opts.readStdin ?? readTokenFromStdin)();
    if (piped) return { ok: true, token: piped, source: "stdin" };
    return {
      ok: false,
      result: {
        ok: false,
        exitCode: ExitCode.Auth,
        error: {
          code: "no_access_token",
          message:
            "--token-stdin was passed but no token arrived on stdin. Pipe one (e.g. `echo $TOKEN | gusto ...`) or drop --token-stdin to fall back to GUSTO_ACCESS_TOKEN / the stored session.",
          environment: defaultEnv(globals.env),
        },
      },
    };
  }
  const envToken = getAccessToken();
  if (envToken) return { ok: true, token: envToken, source: "env" };

  const env = defaultEnv(globals.env);
  const outcome = await sessionOutcome(globals, opts, env);
  if (outcome.kind === "ok") return { ok: true, token: outcome.token, source: "session" };

  return { ok: false, result: await sessionFailure(outcome, env, opts) };
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
function slotDescription(env: Environment): string {
  return `the [${env}] slot of ${credentialsFile()}`;
}

/** Turn a non-`ok` session outcome into the auth failure for it.
 *
 * The three codes are not interchangeable, because the cheapest action that can work differs by
 * state. `refresh_failed` means a usable credential is still on file, so a plain retry costs nothing
 * and often succeeds; `login` is the expensive answer to that - it needs a human at a browser, which
 * is exactly what an agent on a headless box can't produce, so pointing there turns a recoverable
 * state into a dead end. A successful login does mint a new grant and invalidate the refresh token
 * it replaces, which matters to anything else holding that credential. So only `no_access_token` and
 * `session_expired` may suggest `gusto auth login`; `refresh_failed` must steer toward a retry.
 * All three share the `Auth` exit code - callers branch on the code, not the status. */
async function sessionFailure(
  outcome: Exclude<SessionOutcome, { kind: "ok" }>,
  env: Environment,
  opts: AuthOpts,
): Promise<CommandResult<never>> {
  const slot = slotDescription(env);
  const hint = await otherEnvHint(env, opts);
  const withContext = (error: EnvelopeError): CommandResult<never> => ({
    ok: false,
    exitCode: ExitCode.Auth,
    error: { ...error, environment: env, ...(hint ? { hint } : {}) },
  });

  switch (outcome.kind) {
    case "absent":
      return withContext({
        code: "no_access_token",
        message: `no access token for the ${env} environment (read ${slot}). Run \`gusto auth login\`, set GUSTO_ACCESS_TOKEN, or pipe one via --token-stdin.`,
      });
    case "expired":
      return withContext({
        code: "session_expired",
        message: `the ${env} access token expired at ${new Date(outcome.expiresAt).toISOString()} and cannot be refreshed - no refresh token or client credentials in ${slot}. Run \`gusto auth login --env ${env}\` to sign in again.`,
      });
    case "refresh_failed":
      return withContext({
        code: "token_refresh_failed",
        message: `refreshing the ${env} session failed (${oauthReason(outcome.cause)}). The refresh token in ${slot} is still on file and was not replaced - retry the command first. Only run \`gusto auth login --env ${env}\` if the retry fails too, since logging in replaces that refresh token.`,
        ...(outcome.cause.body !== undefined && outcome.cause.body !== null ? { details: outcome.cause.body } : {}),
        ...(outcome.cause.requestId ? { request_id: outcome.cause.requestId } : {}),
      });
  }
}

/** When the requested environment has no usable session, say so about the *other* one.
 *
 * Logging into sandbox and then dropping `--env` walks into a production wall with nothing
 * connecting the failure to the environment, which is the likeliest reason to be here at all. Only
 * reads the other slot; never refreshes it, so producing a hint can't rotate a token nobody asked
 * us to touch. Best-effort, like the stranded-session warning in `authLogoutHandler`: a failed read
 * of the other slot must not change the error we already have to report. */
async function otherEnvHint(env: Environment, opts: AuthOpts): Promise<string | undefined> {
  const other: Environment = env === "production" ? "sandbox" : "production";
  try {
    const store = opts.store ?? resolveStore();
    const session = await store.load(other);
    if (!session?.accessToken) return undefined;
    // The file is already named in the message this hint accompanies, so name only the slot.
    return `a ${other} session is stored in the [${other}] slot of the same file. If you meant that environment, retry with \`--env ${other}\`, or make it the default with \`gusto config set environment ${other}\`.`;
  } catch {
    // the other-environment hint is best-effort; ignore read failures
    return undefined;
  }
}

export function resolveApiContext(
  globals: GlobalFlags,
  opts: ApiContextOpts & { requireCompany: false },
): Promise<Resolved<Extract<ApiContext, { hasCompany: false }>>>;
export function resolveApiContext(globals: GlobalFlags, opts?: ApiContextOpts): Promise<Resolved<CompanyApiContext>>;
export async function resolveApiContext(
  globals: GlobalFlags,
  opts: ApiContextOpts = { requireCompany: true },
): Promise<Resolved<ApiContext>> {
  const resolved = await resolveAuthToken(globals, opts);
  if (!resolved.ok) return resolved;
  const { token, source: tokenSource } = resolved;

  const baseUrl = resolveBaseUrl(globals.env);
  const client = buildApiClient(globals, { baseUrl, token });

  if (opts.requireCompany === false) {
    return { ok: true, ctx: { client, baseUrl, tokenSource, hasCompany: false } };
  }

  // Only borrow the session's company when the token came from the session; an
  // env/stdin token must not silently target an unrelated login's company.
  const fallbackCompany = tokenSource === "session" ? await sessionCompanyUuid(globals, opts) : null;
  const companyUuid = getCompanyUuid(opts.companyOverride) ?? fallbackCompany;
  if (!companyUuid) {
    return {
      ok: false,
      result: {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "no_company_uuid",
          message:
            "no company UUID. Pass --company-uuid <uuid>, set GUSTO_COMPANY_UUID, or log in with a company-scoped token. Look it up via `gusto auth whoami`.",
          // A company is stored per credential slot, so which environment answered decides whether
          // one was available at all.
          environment: defaultEnv(globals.env),
        },
      },
    };
  }

  return { ok: true, ctx: { client, baseUrl, tokenSource, hasCompany: true, companyUuid } };
}

/** The stored login session resolved to a token, or the reason it couldn't be. An unreadable or
 * corrupt credentials file is a real error rather than a credential state, so it surfaces. */
async function sessionOutcome(globals: GlobalFlags, opts: AuthOpts, env: Environment): Promise<SessionOutcome> {
  const store = opts.store ?? resolveStore();
  const http = opts.http ?? oauthHttp(globals);
  return resolveSessionToken(store, env, http, opts.now);
}

/** Company fallback after --company-uuid/env: the companyUuid persisted from a
 * company-scoped login token. */
async function sessionCompanyUuid(globals: GlobalFlags, opts: ApiContextOpts): Promise<string | null> {
  const store = opts.store ?? resolveStore();
  const session = await store.load(defaultEnv(globals.env));
  return session?.companyUuid ?? null;
}

export interface CompanyResourceOpts {
  tokenStdin?: boolean;
  readStdin?: StdinReader;
  companyUuid?: string;
  dryRun?: boolean;
  /** `--confirm`: the operator approved this write, so the agent-mode confirmation gate lets it
   * through. Ignored for reads and dry-runs. */
  confirm?: boolean;
  store?: TokenStore;
  http?: OAuthHttpOptions;
  now?: () => number;
}

/** Shared body of createCompanyResource/putCompanyResource: resolve auth/company context, honor
 * --dry-run (emit the request shape without sending), send `method` to
 * /v1/companies/{company_uuid}/{resource}, and map API/network errors. `includeBody` controls
 * whether the `body` key appears in the dry-run shape — POST always echoes its (required) body;
 * PUT only echoes a body it was actually given. Keeping this in one place stops the two verbs from
 * drifting on dry-run shape or context resolution. */
async function companyResourceRequest(
  globals: GlobalFlags,
  method: "POST" | "PUT",
  resource: string,
  body: unknown,
  includeBody: boolean,
  opts: CompanyResourceOpts,
): Promise<CommandResult> {
  // Human-in-the-loop: in agent mode a write needs an explicit --confirm. Gate before resolving
  // auth/company so an agent learns it must confirm without first needing a valid token. --dry-run
  // and human/TTY mode pass through (see confirmationGate).
  const gate = confirmationGate(globals, method, `/v1/companies/{company_uuid}/${resource}`, {
    confirm: opts.confirm,
    dryRun: opts.dryRun,
  });
  if (gate) return gate;

  const ctx = await resolveApiContext(globals, {
    tokenStdin: opts.tokenStdin,
    readStdin: opts.readStdin,
    companyOverride: opts.companyUuid,
    store: opts.store,
    http: opts.http,
    now: opts.now,
  });
  const bodyShape = includeBody ? { body } : {};
  if (!ctx.ok) {
    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method,
          path: `/v1/companies/{company_uuid}/${resource}`,
          ...bodyShape,
          note: "dry-run: token/company not required",
        },
      };
    }
    return ctx.result;
  }

  const path = `/v1/companies/${ctx.ctx.companyUuid}/${resource}`;
  if (opts.dryRun) {
    return { ok: true, data: { method, path, ...bodyShape } };
  }

  try {
    const response = await ctx.ctx.client.request(method, path, body);
    return { ok: true, data: response.body };
  } catch (err) {
    return toResult(err);
  }
}

/** POST `body` to /v1/companies/{company_uuid}/{resource}. Resolves auth/company context,
 * honors --dry-run (emits the request shape without sending), and maps API/network errors. */
export async function createCompanyResource(
  globals: GlobalFlags,
  resource: string,
  body: unknown,
  opts: CompanyResourceOpts,
): Promise<CommandResult> {
  return companyResourceRequest(globals, "POST", resource, body, true, opts);
}

/** PUT to /v1/companies/{company_uuid}/{resource} (optionally with a body). Same auth/company
 * resolution, --dry-run, and error mapping as createCompanyResource, but for endpoints that mutate
 * an existing resource in place (e.g. payroll prepare). Returns the response body, so callers that
 * need to read the mutated resource back (e.g. the payroll's populated compensations) get it for
 * free. Use this for a straight PUT-and-return; reach for withCompanyContext when the result needs
 * further shaping (see companyShowHandler). */
export async function putCompanyResource(
  globals: GlobalFlags,
  resource: string,
  body: unknown,
  opts: CompanyResourceOpts,
): Promise<CommandResult> {
  return companyResourceRequest(globals, "PUT", resource, body, body !== undefined, opts);
}

export interface ResourceWriteOpts {
  tokenStdin?: boolean;
  readStdin?: StdinReader;
  dryRun?: boolean;
  /** `--confirm`: the operator approved this write, so the agent-mode confirmation gate lets it
   * through. Ignored for dry-runs. */
  confirm?: boolean;
  store?: TokenStore;
  http?: OAuthHttpOptions;
  now?: () => number;
}

/** Send a write to a fully-resolved resource path - the resource UUID is already in `path`, so no
 * company context is needed. The employee-scoped counterpart to createCompanyResource: it applies
 * the agent-mode confirmation gate, honors --dry-run (echoes the request without sending or even
 * resolving auth, since the path needs no interpolation), and maps API/network errors. `body` is
 * omitted from both the request and the dry-run shape when undefined, so a bodyless DELETE stays
 * clean. */
export async function writeResource(
  globals: GlobalFlags,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  opts: ResourceWriteOpts,
): Promise<CommandResult> {
  // Human-in-the-loop: in agent mode a write needs an explicit --confirm. Gate before resolving auth
  // so an agent learns it must confirm without first needing a valid token (see confirmationGate).
  const gate = confirmationGate(globals, method, path, { confirm: opts.confirm, dryRun: opts.dryRun });
  if (gate) return gate;

  const bodyShape = body !== undefined ? { body } : {};
  // The path is already complete, so a dry-run needs no auth - just echo what would be sent.
  if (opts.dryRun) return { ok: true, data: { method, path, ...bodyShape } };

  const resolved = await resolveApiContext(globals, {
    tokenStdin: opts.tokenStdin,
    readStdin: opts.readStdin,
    requireCompany: false,
    store: opts.store,
    http: opts.http,
    now: opts.now,
  });
  if (!resolved.ok) return resolved.result;

  try {
    const response = await resolved.ctx.client.request(method, path, body);
    return { ok: true, data: response.body };
  } catch (err) {
    return toResult(err);
  }
}

/** Resolve auth/company context, GET the path from `buildPath`, and map API/network errors.
 * `buildPath` receives a context narrowed to `hasCompany: true`, so accessing `companyUuid`
 * is a compile-error-safe operation. */
export async function fetchCompanyResource(
  globals: GlobalFlags,
  opts: CompanyResourceOpts,
  buildPath: (ctx: CompanyApiContext) => string,
): Promise<CommandResult> {
  const resolved = await resolveApiContext(globals, {
    tokenStdin: opts.tokenStdin,
    readStdin: opts.readStdin,
    companyOverride: opts.companyUuid,
    store: opts.store,
    http: opts.http,
    now: opts.now,
  });
  if (!resolved.ok) return resolved.result;

  try {
    const response = await resolved.ctx.client.get(buildPath(resolved.ctx));
    return { ok: true, data: response.body };
  } catch (err) {
    return toResult(err);
  }
}

/** Resolve company context, then run `fn` with the company-scoped client and
 * map any API/network error it throws. For multi-call flows (read-then-write,
 * compound sequences) where the single-request helpers don't fit. */
export async function withCompanyContext(
  globals: GlobalFlags,
  opts: CompanyResourceOpts,
  fn: (ctx: CompanyApiContext) => Promise<CommandResult>,
): Promise<CommandResult> {
  const resolved = await resolveApiContext(globals, {
    tokenStdin: opts.tokenStdin,
    readStdin: opts.readStdin,
    companyOverride: opts.companyUuid,
    store: opts.store,
    http: opts.http,
    now: opts.now,
  });
  if (!resolved.ok) return resolved.result;

  try {
    return await fn(resolved.ctx);
  } catch (err) {
    return toResult(err);
  }
}

/** GET a path with an already-resolved client and map API/network errors. The bare
 * primitive shared by `fetchResource` and any handler that already holds a context
 * (e.g. `authWhoamiHandler` needs the resolved `tokenSource` *and* the response body,
 * so it resolves the context itself and reuses this helper for the request). */
export async function fetchAtPath<T = unknown>(client: ApiClient, path: string): Promise<CommandResult<T>> {
  try {
    const response = await client.get<T>(path);
    return { ok: true, data: response.body };
  } catch (err) {
    return toResult(err);
  }
}

/** Resolve auth context only (no company required), GET the path, and map API/network errors.
 * Use for resource endpoints where the resource UUID is already in the path
 * (e.g. /v1/employees/{uuid}). For company-scoped paths, use `fetchCompanyResource`. */
export async function fetchResource<T = unknown>(
  globals: GlobalFlags,
  opts: {
    tokenStdin?: boolean;
    readStdin?: StdinReader;
    store?: TokenStore;
    http?: OAuthHttpOptions;
    now?: () => number;
  },
  buildPath: () => string,
): Promise<CommandResult<T>> {
  const resolved = await resolveApiContext(globals, {
    tokenStdin: opts.tokenStdin,
    readStdin: opts.readStdin,
    requireCompany: false,
    store: opts.store,
    http: opts.http,
    now: opts.now,
  });
  if (!resolved.ok) return resolved.result;
  return fetchAtPath<T>(resolved.ctx.client, buildPath());
}
