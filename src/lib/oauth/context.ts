import { ApiClient } from "../api-client.ts";
import { resolveInstallIdHeader } from "../config.ts";
import { resolveApiVersion, resolveBaseUrl } from "../env.ts";
import type { GlobalFlags } from "../global-flags.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";

/** Async because it resolves the anonymous install_id from the on-disk config. */
export async function oauthHttp(globals: GlobalFlags): Promise<OAuthHttpOptions> {
  return {
    baseUrl: resolveBaseUrl(globals.env),
    installId: await resolveInstallIdHeader(),
  };
}

/** A single-shot bearer ApiClient for the authed endpoints the oauth flows hit
 * (token_info) - no retries, shares the injected fetch. */
export function oauthApiClient(http: OAuthHttpOptions, token: string): ApiClient {
  return new ApiClient({
    baseUrl: http.baseUrl,
    token,
    apiVersion: resolveApiVersion(),
    installId: http.installId,
    fetchImpl: http.fetchImpl,
    maxRetries: 0,
  });
}
