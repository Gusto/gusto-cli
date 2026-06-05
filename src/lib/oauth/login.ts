import { spawn } from "node:child_process";
import type { Environment } from "../global-flags.ts";
import { oauthApiClient } from "./context.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";
import { buildAuthorizeUrl, exchangeCode, generatePkce, randomState, startLoopbackServer } from "./pkce.ts";
import { ensureClientCreds } from "./session.ts";
import type { TokenStore } from "./token-store.ts";

export interface TokenInfo {
  scope?: string;
  resource?: { type?: string; uuid?: string };
  resource_owner?: { type?: string; uuid?: string };
}

/** The Mode 2 token is company-scoped: token_info's `resource` is the Company. */
export function companyUuidFromTokenInfo(info: TokenInfo): string | undefined {
  if (info.resource?.type === "Company" && typeof info.resource.uuid === "string") {
    return info.resource.uuid;
  }
  return undefined;
}

export interface LoginDeps {
  store: TokenStore;
  http: OAuthHttpOptions;
  openBrowser?: (url: string) => Promise<void>;
  print?: (line: string) => void;
  timeoutMs?: number;
  now?: () => number;
}

export async function login(env: Environment, deps: LoginDeps): Promise<TokenInfo> {
  const { store, http } = deps;
  const print = deps.print ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = deps.now ?? Date.now;

  const creds = await ensureClientCreds(store, env, http);
  const { verifier, challenge } = generatePkce();
  const state = randomState();

  const server = await startLoopbackServer(state, { timeoutMs: deps.timeoutMs });
  try {
    const authorizeUrl = buildAuthorizeUrl(http.baseUrl, {
      clientId: creds.clientId,
      redirectUri: server.redirectUri,
      challenge,
      state,
    });
    await openOrPrint(authorizeUrl, deps.openBrowser, print);
    print("Waiting for you to finish signing in...");

    const code = await server.waitForCode();
    const tokens = await exchangeCode(http, { code, verifier, redirectUri: server.redirectUri, creds }, now());
    const info = await fetchTokenInfo(http, tokens.accessToken);

    await store.save(env, {
      ...creds,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    return info;
  } finally {
    server.close();
  }
}

export async function fetchTokenInfo(http: OAuthHttpOptions, token: string): Promise<TokenInfo> {
  const res = await oauthApiClient(http, token).get<TokenInfo>("/v1/token_info");
  return res.body;
}

export async function openOrPrint(
  url: string,
  openBrowser: ((url: string) => Promise<void>) | undefined,
  print: (line: string) => void,
): Promise<void> {
  const open = openBrowser ?? defaultOpenBrowser;
  try {
    await open(url);
    print("Opened your browser to sign in. If it didn't open, visit:");
    print(`  ${url}`);
  } catch {
    print("Open this URL in your browser to sign in:");
    print(`  ${url}`);
  }
}

export function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
