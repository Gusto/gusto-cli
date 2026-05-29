import { ApiClient } from "./api-client.ts";
import { getAccessToken, getCompanyUuid, resolveApiVersion, resolveBaseUrl } from "./env.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
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
