import { canOpenBrowser, defaultOpenBrowser } from "../browser.ts";
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

/** Structured event emitted by `login` the moment the sign-in URL is ready, before
 * blocking on the OAuth callback. Consumed by the `--agent` surface to write a JSON
 * line to stdout so agent harnesses can surface the URL without buffering the whole
 * subprocess. */
export interface SignInUrlEvent {
  event: "sign_in_url";
  sign_in_url: string;
  state: string;
}

export interface LoginDeps {
  store: TokenStore;
  http: OAuthHttpOptions;
  openBrowser?: (url: string) => Promise<void>;
  /** Force print-only (the `--no-browser` flag). When unset, the browser opens only
   * if `browserAvailable()` says this environment can reach one. */
  noBrowser?: boolean;
  /** Whether this environment can open a browser. Defaults to `canOpenBrowser`; injected in tests. */
  browserAvailable?: () => boolean;
  print?: (line: string) => void;
  emitEvent?: (event: SignInUrlEvent) => void;
  now?: () => number;
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  heartbeatIntervalMs?: number;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export async function login(env: Environment, deps: LoginDeps): Promise<TokenInfo> {
  const { store, http } = deps;
  const print = deps.print ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = deps.now ?? Date.now;

  const creds = await ensureClientCreds(store, env, http);
  const { verifier, challenge } = generatePkce();
  const state = randomState();

  const server = await startLoopbackServer(state);
  try {
    const authorizeUrl = buildAuthorizeUrl(http.baseUrl, {
      clientId: creds.clientId,
      redirectUri: server.redirectUri,
      challenge,
      state,
    });
    deps.emitEvent?.({ event: "sign_in_url", sign_in_url: authorizeUrl, state });
    // Open the browser only when the user didn't force --no-browser AND this
    // environment can actually reach one. The agent surface still got the URL via
    // emitEvent above, so a headless agent isn't left without the link.
    const shouldOpenBrowser = !deps.noBrowser && (deps.browserAvailable ?? canOpenBrowser)();
    if (shouldOpenBrowser) {
      await openOrPrint(authorizeUrl, deps.openBrowser, print);
    } else {
      printManualUrl(authorizeUrl, print);
    }
    print(
      "Waiting for you to complete sign-in in your browser. The CLI will continue automatically once you finish; press Ctrl-C to cancel.",
    );

    const stopHeartbeat = startHeartbeat(print, deps, now);
    let code: string;
    try {
      code = await server.waitForCode();
    } finally {
      stopHeartbeat();
    }
    try {
      const tokens = await exchangeCode(http, { code, verifier, redirectUri: server.redirectUri, creds }, now());
      const info = await fetchTokenInfo(http, tokens.accessToken);
      const companyUuid = companyUuidFromTokenInfo(info);

      // Rebuild from the new token (don't spread the prior session) so a stale
      // companyUuid can't survive a re-login that yields a non-company token.
      await store.save(env, {
        ...creds,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        ...(companyUuid ? { companyUuid } : {}),
      });
      server.complete(true);
      return info;
    } catch (err) {
      server.complete(false);
      throw err;
    }
  } finally {
    server.close();
  }
}

function startHeartbeat(print: (line: string) => void, deps: LoginDeps, now: () => number): () => void {
  const intervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const setIntervalFn = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const start = now();
  const handle = setIntervalFn(() => {
    const elapsed = Math.round((now() - start) / 1000);
    print(`Open the URL above to complete sign-in (${elapsed}s elapsed)`);
  }, intervalMs);
  return () => clearIntervalFn(handle);
}

export async function fetchTokenInfo(http: OAuthHttpOptions, token: string): Promise<TokenInfo> {
  const res = await oauthApiClient(http, token).get<TokenInfo>("/v1/token_info");
  return res.body;
}

export async function openOrPrint(
  url: string,
  openBrowser: ((url: string) => Promise<void>) | undefined,
  print: (line: string) => void,
  isTty = process.stderr.isTTY === true,
): Promise<void> {
  const open = openBrowser ?? defaultOpenBrowser;
  try {
    await open(url);
    print("Opened your browser to sign in. If it didn't open, visit:");
    print(`  ${formatUrlForTerminal(url, isTty)}`);
  } catch {
    printManualUrl(url, print, isTty);
  }
}

function printManualUrl(url: string, print: (line: string) => void, isTty = process.stderr.isTTY === true): void {
  print("Open this URL in your browser to sign in:");
  print(`  ${formatUrlForTerminal(url, isTty)}`);
}

/** Wrap the URL in an OSC 8 terminal hyperlink so supporting terminals (iTerm2,
 * Terminal.app, VS Code, WezTerm, Ghostty) render it as a true clickable link.
 * Falls back to the bare URL when the stream isn't a TTY (piped / agent / headless). */
export function formatUrlForTerminal(url: string, isTty: boolean): string {
  if (!isTty) return url;
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}
