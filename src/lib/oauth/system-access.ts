import { OAUTH_PATHS, type OAuthHttpOptions, basicAuth, postForm } from "./endpoints.ts";
import type { ClientCreds, TokenSet } from "./types.ts";

interface TokenResponse {
  access_token?: unknown;
  scope?: unknown;
}

/** Mint a system_access token via client credentials (no refresh token; used once, not persisted). */
export async function mintSystemAccess(opts: OAuthHttpOptions, creds: ClientCreds): Promise<TokenSet> {
  const body = await postForm(
    opts,
    OAUTH_PATHS.token,
    { grant_type: "system_access" },
    basicAuth(creds.clientId, creds.clientSecret),
  );

  const { access_token, scope } = body as TokenResponse;
  if (typeof access_token !== "string") {
    throw new Error("system_access response missing access_token");
  }
  return { accessToken: access_token, scope: typeof scope === "string" ? scope : undefined };
}
