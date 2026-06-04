import { ApiClient } from "../api-client.ts";
import { resolveApiVersion, resolveBaseUrl } from "../env.ts";
import type { GlobalFlags } from "../global-flags.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";
import type { Env } from "./login.ts";

export function resolveEnv(globals: GlobalFlags): Env {
  return globals.env === "production" ? "production" : "sandbox";
}

export function oauthHttp(globals: GlobalFlags): OAuthHttpOptions {
  return { baseUrl: resolveBaseUrl(globals.env) };
}

/** A single-shot bearer ApiClient for the authed endpoints the oauth flows hit
 * (token_info, /v1/provision) - no retries, shares the injected fetch. */
export function oauthApiClient(http: OAuthHttpOptions, token: string): ApiClient {
  return new ApiClient({
    baseUrl: http.baseUrl,
    token,
    apiVersion: resolveApiVersion(),
    fetchImpl: http.fetchImpl,
    maxRetries: 0,
  });
}
