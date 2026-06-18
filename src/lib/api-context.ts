import { ApiClient } from "./api-client.ts";
import { getAccessToken, getCompanyUuid, resolveApiVersion, resolveBaseUrl } from "./env.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { toResult } from "./handle-api-error.ts";
import { oauthHttp, resolveEnv } from "./oauth/context.ts";
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
 * logged-in identity. See AINT-673. The session is only loaded when no explicit
 * token is present, so a bad GUSTO_ACCESS_TOKEN can't be masked by an on-disk
 * session refresh. `source` tells callers which credential won. */
export async function resolveAuthToken(globals: GlobalFlags, opts: AuthOpts): Promise<ResolvedToken> {
  if (opts.tokenStdin) {
    const piped = await (opts.readStdin ?? readTokenFromStdin)();
    if (piped) return { ok: true, token: piped, source: "stdin" };
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
    return await getValidUserToken(store, resolveEnv(globals), http, opts.now);
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
  const session = await store.load(resolveEnv(globals));
  return session?.companyUuid ?? null;
}

export interface CompanyResourceOpts {
  tokenStdin?: boolean;
  readStdin?: StdinReader;
  companyUuid?: string;
  dryRun?: boolean;
  store?: TokenStore;
  http?: OAuthHttpOptions;
  now?: () => number;
}

/** POST `body` to /v1/companies/{company_uuid}/{resource}. Resolves auth/company context,
 * honors --dry-run (emits the request shape without sending), and maps API/network errors. */
export async function createCompanyResource(
  globals: GlobalFlags,
  resource: string,
  body: unknown,
  opts: CompanyResourceOpts,
): Promise<CommandResult> {
  const ctx = await resolveApiContext(globals, {
    tokenStdin: opts.tokenStdin,
    readStdin: opts.readStdin,
    companyOverride: opts.companyUuid,
    store: opts.store,
    http: opts.http,
    now: opts.now,
  });
  if (!ctx.ok) {
    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: `/v1/companies/{company_uuid}/${resource}`,
          body,
          note: "dry-run: token/company not required",
        },
      };
    }
    return ctx.result;
  }

  const path = `/v1/companies/${ctx.ctx.companyUuid}/${resource}`;
  if (opts.dryRun) {
    return { ok: true, data: { method: "POST", path, body } };
  }

  try {
    const response = await ctx.ctx.client.post(path, body);
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

  try {
    const response = await resolved.ctx.client.get<T>(buildPath());
    return { ok: true, data: response.body };
  } catch (err) {
    return toResult(err);
  }
}
