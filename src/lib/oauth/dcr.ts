import { OAUTH_PATHS, type OAuthHttpOptions, postJson } from "./endpoints.ts";
import type { ClientCreds } from "./types.ts";

/** RFC 8252 loopback redirect registered at DCR time. The path must match the
 * runtime callback path; the port floats (the server's loopback match ignores it). */
export const LOOPBACK_REDIRECT_URI = "http://127.0.0.1/callback";
export const CALLBACK_PATH = "/callback";

interface RegisterResponse {
  client_id?: unknown;
  client_secret?: unknown;
}

export async function registerCliClient(opts: OAuthHttpOptions): Promise<ClientCreds> {
  const body = await postJson(opts, OAUTH_PATHS.register, {
    client_type: "cli",
    client_name: "Gusto CLI",
    redirect_uris: [LOOPBACK_REDIRECT_URI],
    token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["authorization_code", "refresh_token"],
  });

  const { client_id, client_secret } = body as RegisterResponse;
  if (typeof client_id !== "string" || typeof client_secret !== "string") {
    throw new Error("DCR response missing client_id/client_secret");
  }
  return { clientId: client_id, clientSecret: client_secret };
}
