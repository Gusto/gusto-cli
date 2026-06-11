import type { Environment } from "../global-flags.ts";
import { oauthApiClient } from "./context.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";
import type { ProvisionPayload } from "./provision-input.ts";
import { ensureClientCreds } from "./session.ts";
import { mintSystemAccess } from "./system-access.ts";
import type { TokenStore } from "./token-store.ts";
import type { ClientCreds } from "./types.ts";

interface ProvisionResponse {
  account_claim_url?: unknown;
}

export interface ProvisionDeps {
  store: TokenStore;
  http: OAuthHttpOptions;
}

export interface ProvisionResult {
  accountClaimUrl: string;
}

/**
 * Create the company and return its claim URL - nothing more. Provision is
 * deliberately non-blocking and agent-drivable: it does NOT open a browser,
 * wait for the user to claim, or run OAuth. The caller (or the agent) claims
 * the account in the browser and then runs `gusto auth login` separately to
 * obtain the company-scoped Mode 2 token.
 */
export async function provision(
  env: Environment,
  payload: ProvisionPayload,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const { store, http } = deps;
  const creds = await ensureClientCreds(store, env, http);
  const accountClaimUrl = await callProvision(http, creds, payload);
  return { accountClaimUrl };
}

/**
 * POST /v1/provision with a freshly minted system_access token. The create is
 * non-idempotent, so it's issued exactly once and any error (including 401)
 * propagates - re-running the command is safe because auth is checked before
 * the server creates anything.
 */
export async function callProvision(
  http: OAuthHttpOptions,
  creds: ClientCreds,
  payload: ProvisionPayload,
): Promise<string> {
  const token = (await mintSystemAccess(http, creds)).accessToken;
  // The endpoint wraps the top-level body under `provision` itself
  // (wrap_params_in_root), so send {user, company} unwrapped - wrapping here
  // would double-nest it and the server would see no user/company.
  const res = await oauthApiClient(http, token).post<ProvisionResponse>("/v1/provision", payload);
  const url = res.body?.account_claim_url;
  if (typeof url !== "string") throw new Error("/v1/provision response missing account_claim_url");
  return url;
}
