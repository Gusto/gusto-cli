import { OAUTH_PATHS, type OAuthHttpOptions, basicAuth, postForm } from "./endpoints.ts";
import type { ClientCreds } from "./types.ts";

// Best-effort RFC 7009 revoke: never throws (logout still clears locally), and
// the DCR-creds path against the root Doorkeeper endpoint is unproven (see spec).
export async function revokeToken(opts: OAuthHttpOptions, token: string, creds: ClientCreds): Promise<boolean> {
  try {
    await postForm(
      opts,
      OAUTH_PATHS.revoke,
      { token, token_type_hint: "access_token" },
      basicAuth(creds.clientId, creds.clientSecret),
    );
    return true;
  } catch {
    return false;
  }
}
