import { createHash, randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import { OAUTH_PATHS, type OAuthHttpOptions, basicAuth, postForm, toTokenSet } from "./endpoints.ts";
import { CALLBACK_PATH } from "./dcr.ts";
import type { ClientCreds, TokenSet } from "./types.ts";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 S256 verifier + challenge. */
export function generatePkce(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return base64Url(randomBytes(16));
}

export function buildAuthorizeUrl(
  baseUrl: string,
  params: { clientId: string; redirectUri: string; challenge: string; state: string; scope?: string },
): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}${OAUTH_PATHS.authorize}`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  if (params.scope) url.searchParams.set("scope", params.scope);
  return url.toString();
}

export interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
}

export function parseCallback(requestUrl: string): CallbackResult {
  const url = new URL(requestUrl, "http://127.0.0.1");
  return {
    code: url.searchParams.get("code") ?? undefined,
    state: url.searchParams.get("state") ?? undefined,
    error: url.searchParams.get("error") ?? undefined,
  };
}

export async function exchangeCode(
  opts: OAuthHttpOptions,
  args: { code: string; verifier: string; redirectUri: string; creds: ClientCreds },
  now: number = Date.now(),
): Promise<TokenSet> {
  const body = await postForm(
    opts,
    OAUTH_PATHS.token,
    {
      grant_type: "authorization_code",
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri,
      client_id: args.creds.clientId,
    },
    basicAuth(args.creds.clientId, args.creds.clientSecret),
  );
  return toTokenSet(body, now);
}

export async function refreshToken(
  opts: OAuthHttpOptions,
  args: { refreshToken: string; creds: ClientCreds },
  now: number = Date.now(),
): Promise<TokenSet> {
  const body = await postForm(
    opts,
    OAUTH_PATHS.token,
    {
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.creds.clientId,
    },
    basicAuth(args.creds.clientId, args.creds.clientSecret),
  );
  return toTokenSet(body, now);
}

/** The loopback redirect URI for the bound port (path must equal the registered path). */
export function redirectUriForPort(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}${CALLBACK_PATH}`;
}

export interface LoopbackServer {
  redirectUri: string;
  port: number;
  waitForCode(): Promise<string>;
  close(): void;
}

/** Bind the loopback callback server first (so the caller learns the port and
 * can build the authorize URL), then await the redirect via `waitForCode()`. */
export function startLoopbackServer(
  expectedState: string,
  opts: { timeoutMs?: number; host?: string } = {},
): Promise<LoopbackServer> {
  const host = opts.host ?? "127.0.0.1";
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return new Promise<LoopbackServer>((resolveServer, rejectServer) => {
    let settled = false;
    let listening = false;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server: Server = createServer((req, res) => {
      const parsed = parseCallback(req.url ?? "/");
      const ok = parsed.code != null && parsed.error == null && parsed.state === expectedState;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" });
      res.end(
        ok ? "Gusto CLI: login complete. You can close this tab." : "Gusto CLI: login failed. Return to your terminal.",
      );
      if (parsed.error) return finish(new Error(`authorization failed: ${parsed.error}`));
      if (parsed.state !== expectedState) return finish(new Error("state mismatch on callback (possible CSRF)"));
      if (!parsed.code) return finish(new Error("callback missing authorization code"));
      finish(null, parsed.code);
    });

    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for browser callback after ${timeoutMs}ms`)),
      timeoutMs,
    );

    function finish(err: Error | null, code?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (err) rejectCode(err);
      else resolveCode(code as string);
    }

    server.on("error", (err) => {
      if (!listening) rejectServer(err);
      else finish(err);
    });

    server.listen(0, host, () => {
      listening = true;
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveServer({
        redirectUri: redirectUriForPort(port, host),
        port,
        waitForCode: () => codePromise,
        close: () => finish(new Error("login cancelled")),
      });
    });
  });
}
