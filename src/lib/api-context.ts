import { ApiClient } from "./api-client.ts";
import { getAccessToken, getCompanyUuid, resolveApiVersion, resolveBaseUrl } from "./env.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { toResult } from "./handle-api-error.ts";
import type { CommandResult } from "./runner.ts";

interface ApiContextBase {
  client: ApiClient;
  baseUrl: string;
}

export type ApiContext =
  | (ApiContextBase & { hasCompany: true; companyUuid: string })
  | (ApiContextBase & { hasCompany: false });

export type CompanyApiContext = Extract<ApiContext, { hasCompany: true }>;

export interface ApiContextOpts {
  requireCompany?: boolean;
  tokenOverride?: string;
  companyOverride?: string;
}

type Resolved<T> = { ok: true; ctx: T } | { ok: false; result: CommandResult<never> };

export function resolveApiContext(
  globals: GlobalFlags,
  opts: ApiContextOpts & { requireCompany: false },
): Resolved<Extract<ApiContext, { hasCompany: false }>>;
export function resolveApiContext(globals: GlobalFlags, opts?: ApiContextOpts): Resolved<CompanyApiContext>;
export function resolveApiContext(
  globals: GlobalFlags,
  opts: ApiContextOpts = { requireCompany: true },
): Resolved<ApiContext> {
  const token = getAccessToken(opts.tokenOverride);
  if (!token) {
    return {
      ok: false,
      result: {
        ok: false,
        exitCode: ExitCode.Auth,
        error: {
          code: "no_access_token",
          message: "no access token. Set GUSTO_ACCESS_TOKEN, pass --token, or wait for `gusto auth login` (AINT-561).",
        },
      },
    };
  }

  const baseUrl = resolveBaseUrl(globals.env);
  const client = new ApiClient({ baseUrl, token, apiVersion: resolveApiVersion() });

  if (opts.requireCompany === false) {
    return { ok: true, ctx: { client, baseUrl, hasCompany: false } };
  }

  const companyUuid = getCompanyUuid(opts.companyOverride);
  if (!companyUuid) {
    return {
      ok: false,
      result: {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "no_company_uuid",
          message:
            "no company UUID. Pass --company-uuid <uuid> or set GUSTO_COMPANY_UUID. Look it up via `gusto auth whoami`.",
        },
      },
    };
  }

  return { ok: true, ctx: { client, baseUrl, hasCompany: true, companyUuid } };
}

export interface CompanyResourceOpts {
  token?: string;
  companyUuid?: string;
  dryRun?: boolean;
}

/** POST `body` to /v1/companies/{company_uuid}/{resource}. Resolves auth/company context,
 * honors --dry-run (emits the request shape without sending), and maps API/network errors. */
export async function createCompanyResource(
  globals: GlobalFlags,
  resource: string,
  body: unknown,
  opts: CompanyResourceOpts,
): Promise<CommandResult> {
  const ctx = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
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
  const resolved = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
  if (!resolved.ok) return resolved.result;

  try {
    const response = await resolved.ctx.client.get(buildPath(resolved.ctx));
    return { ok: true, data: response.body };
  } catch (err) {
    return toResult(err);
  }
}

/** Resolve auth context only (no company required), GET the path, and map API/network errors.
 * Use for resource endpoints where the resource UUID is already in the path
 * (e.g. /v1/employees/{uuid}). For company-scoped paths, use `fetchCompanyResource`. */
export async function fetchResource(
  globals: GlobalFlags,
  opts: { token?: string },
  buildPath: () => string,
): Promise<CommandResult> {
  const resolved = resolveApiContext(globals, { tokenOverride: opts.token, requireCompany: false });
  if (!resolved.ok) return resolved.result;

  try {
    const response = await resolved.ctx.client.get(buildPath());
    return { ok: true, data: response.body };
  } catch (err) {
    return toResult(err);
  }
}
