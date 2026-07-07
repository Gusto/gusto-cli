import { ApiClient } from "./api-client.ts";
import { confirmationGate } from "./confirm.ts";
import { defaultEnv, getAccessToken, getCompanyUuid, resolveApiVersion, resolveBaseUrl } from "./env.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { toResult } from "./handle-api-error.ts";
import { oauthHttp } from "./oauth/context.ts";
import { OAuthError, type OAuthHttpOptions } from "./oauth/endpoints.ts";
import { getValidUserToken } from "./oauth/session.ts";
import { type TokenStore, resolveStore } from "./oauth/token-store.ts";
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
        },
      },
    };
  }
  const envToken = getAccessToken();
  if (envToken) return { ok: true, token: envToken, source: "env" };

  const session = await sessionToken(globals, opts);
  if (session) return { ok: true, token: session, source: "session" };

  return {
    ok: false,
    result: {
      ok: false,
      exitCode: ExitCode.Auth,
      error: {
        code: "no_access_token",
        message: "no access token. Run `gusto auth login`, set GUSTO_ACCESS_TOKEN, or pipe one via --token-stdin.",
      },
    },
  };
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
  const client = new ApiClient({ baseUrl, token, apiVersion: resolveApiVersion() });

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
        },
      },
    };
  }

  return { ok: true, ctx: { client, baseUrl, tokenSource, hasCompany: true, companyUuid } };
}

/** The token from the stored login session, refreshed on near-expiry; null if none. */
async function sessionToken(globals: GlobalFlags, opts: AuthOpts): Promise<string | null> {
  const store = opts.store ?? resolveStore();
  const http = opts.http ?? oauthHttp(globals);
  try {
    return await getValidUserToken(store, defaultEnv(globals.env), http, opts.now);
  } catch (err) {
    // A failed token refresh means re-login - report "no token". Anything else
    // (unreadable/corrupt session file, etc.) is a real error; let it surface.
    if (err instanceof OAuthError) return null;
    throw err;
  }
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
