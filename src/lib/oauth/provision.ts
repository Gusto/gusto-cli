import { ApiError } from "../api-client.ts";
import { oauthApiClient } from "./context.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";
import { type Env, type LoginDeps, type TokenInfo, login } from "./login.ts";
import type { ProvisionPayload } from "./provision-input.ts";
import { ensureClientCreds } from "./session.ts";
import { mintSystemAccess } from "./system-access.ts";
import type { ClientCreds } from "./types.ts";

interface ProvisionResponse {
  account_claim_url?: unknown;
}

export interface ProvisionDeps extends LoginDeps {
  confirmClaim?: () => Promise<void>;
}

export interface ProvisionResult {
  accountClaimUrl: string;
  tokenInfo: TokenInfo;
}

export async function provision(env: Env, payload: ProvisionPayload, deps: ProvisionDeps): Promise<ProvisionResult> {
  const { store, http } = deps;
  const print = deps.print ?? ((l: string) => process.stderr.write(`${l}\n`));

  const creds = await ensureClientCreds(store, env, http);
  const accountClaimUrl = await callProvision(http, creds, payload);

  print("Company created. Finish claiming the account in your browser:");
  print(`  ${accountClaimUrl}`);
  await openClaim(accountClaimUrl, deps.openBrowser, print);
  if (deps.confirmClaim) await deps.confirmClaim();

  const tokenInfo = await login(env, deps); // Mode 2: gated on the claim being done
  return { accountClaimUrl, tokenInfo };
}

/** POST /v1/provision with a freshly minted system_access token; re-mint once on 401. */
export async function callProvision(
  http: OAuthHttpOptions,
  creds: ClientCreds,
  payload: ProvisionPayload,
): Promise<string> {
  const run = async (): Promise<string> => {
    const token = (await mintSystemAccess(http, creds)).accessToken;
    // The endpoint wraps the top-level body under `provision` itself
    // (wrap_params_in_root), so send {user, company} unwrapped - wrapping here
    // would double-nest it and the server would see no user/company.
    const res = await oauthApiClient(http, token).post<ProvisionResponse>("/v1/provision", payload);
    const url = res.body?.account_claim_url;
    if (typeof url !== "string") throw new Error("/v1/provision response missing account_claim_url");
    return url;
  };

  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return run();
    throw err;
  }
}

async function openClaim(
  url: string,
  openBrowser: ((url: string) => Promise<void>) | undefined,
  print: (line: string) => void,
): Promise<void> {
  if (!openBrowser) return;
  try {
    await openBrowser(url);
  } catch {
    print("(couldn't open a browser automatically - use the URL above)");
  }
}
