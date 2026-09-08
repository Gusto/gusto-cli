import { ApiClient } from "../api-client.ts";
import { resolveInstallIdHeader } from "../config.ts";
import { resolveApiVersion, resolveBaseUrl } from "../env.ts";
import type { Environment, GlobalFlags } from "../global-flags.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";

/** Async because it resolves the anonymous install_id from the on-disk config. */
export async function oauthHttp(globals: GlobalFlags): Promise<OAuthHttpOptions> {
  return {
    baseUrl: resolveBaseUrl(globals.env),
    installId: await resolveInstallIdHeader(),
  };
}

/** A single-shot bearer ApiClient for the authed endpoints the oauth flows hit
 * (token_info) - no retries, shares the injected fetch.
 *
 * Deliberately not routed through `buildApiClient`: that one attaches the `--verbose` observer from
 * `GlobalFlags`, which this has no access to (tracked as a follow-up). It does carry an `AuthContext`,
 * because that is what a 401 needs to say which credential was refused and in which environment -
 * without it, the one auth failure raised from inside the login flow is also the only one that can't
 * name either. `login` as the source is what distinguishes it from the token a command resolves. */
export function oauthApiClient(http: OAuthHttpOptions, token: string, environment: Environment): ApiClient {
  return new ApiClient({
    baseUrl: http.baseUrl,
    token,
    apiVersion: resolveApiVersion(),
    installId: http.installId,
    fetchImpl: http.fetchImpl,
    maxRetries: 0,
    auth: { tokenSource: "login", environment },
  });
}
