import { ApiClient } from "./api-client.ts";
import { getAccessToken, getCompanyUuid, resolveApiVersion, resolveBaseUrl } from "./env.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { toResult } from "./handle-api-error.ts";
import type { CommandResult } from "./runner.ts";

export interface ApiContext {
  client: ApiClient;
  companyUuid: string;
  baseUrl: string;
}

export interface ApiContextOpts {
  requireCompany?: boolean;
  tokenOverride?: string;
  companyOverride?: string;
}

export function resolveApiContext(
  globals: GlobalFlags,
  opts: ApiContextOpts = { requireCompany: true },
): { ok: true; ctx: ApiContext } | { ok: false; result: CommandResult<never> } {
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
    return { ok: true, ctx: { client, companyUuid: "", baseUrl } };
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

  return { ok: true, ctx: { client, companyUuid, baseUrl } };
}

export interface CreateResourceOpts {
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
  opts: CreateResourceOpts,
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
 * `buildPath` receives the resolved context so company-scoped paths can use `companyUuid`. */
export async function fetchResource(
  globals: GlobalFlags,
  ctxOpts: ApiContextOpts,
  buildPath: (ctx: ApiContext) => string,
): Promise<CommandResult> {
  const resolved = resolveApiContext(globals, ctxOpts);
  if (!resolved.ok) return resolved.result;

  try {
    const response = await resolved.ctx.client.get(buildPath(resolved.ctx));
    return { ok: true, data: response.body };
  } catch (err) {
    return toResult(err);
  }
}
