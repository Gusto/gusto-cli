import { OAUTH_PATHS, type OAuthHttpOptions, basicAuth, postForm, toTokenSet } from "./endpoints.ts";
import type { ClientCreds, TokenSet } from "./types.ts";

/** Mint a system_access token via client credentials (no refresh token; used once, not persisted). */
export async function mintSystemAccess(
  opts: OAuthHttpOptions,
  creds: ClientCreds,
  now: number = Date.now(),
): Promise<TokenSet> {
  const body = await postForm(
    opts,
    OAUTH_PATHS.token,
    { grant_type: "system_access" },
    basicAuth(creds.clientId, creds.clientSecret),
  );
  return toTokenSet(body, now);
}
