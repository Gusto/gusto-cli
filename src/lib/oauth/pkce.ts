import { createHash, randomBytes } from "node:crypto";
import { type Server, type ServerResponse, createServer } from "node:http";
import { OAUTH_PATHS, type OAuthHttpOptions, basicAuth, postForm, toTokenSet } from "./endpoints.ts";
import { CALLBACK_PATH } from "./dcr.ts";
import type { ClientCreds, TokenSet } from "./types.ts";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256 verifier + challenge. */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(16).toString("base64url");
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

function isValidCallback(parsed: CallbackResult, expectedState: string): parsed is { code: string; state: string } {
  return parsed.code != null && parsed.error == null && parsed.state === expectedState;
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
  /** Flush the held callback response with a pass/fail page. The server keeps
   * the response open after `waitForCode()` resolves so the browser tab can't
   * claim "login complete" before the token exchange has actually run. */
  complete(ok: boolean): void;
  close(): void;
}

const SUCCESS_PAGE = "Gusto CLI: login complete. You can close this tab.";
const FAILURE_PAGE = "Gusto CLI: login failed. Return to your terminal.";
const RETURNING_PAGE = "Gusto CLI: returning to your terminal...";

/** Bind the loopback callback server first (so the caller learns the port and
 * can build the authorize URL), then await the redirect via `waitForCode()`.
 * No timeout: matches `gh auth login` / `aws sso login` style. The user Ctrl-Cs
 * to bail; the server is closed via `close()` on the returned handle. */
export function startLoopbackServer(expectedState: string, opts: { host?: string } = {}): Promise<LoopbackServer> {
  const host = opts.host ?? "127.0.0.1";

  return new Promise<LoopbackServer>((resolveServer, rejectServer) => {
    let settled = false;
    let listening = false;
    let completed = false;
    let pendingRes: ServerResponse | undefined;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server: Server = createServer((req, res) => {
      const parsed = parseCallback(req.url ?? "/");

      if (!isValidCallback(parsed, expectedState)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(FAILURE_PAGE);
        if (parsed.error) return fail(new Error(`authorization failed: ${parsed.error}`));
        if (parsed.state !== expectedState) return fail(new Error("state mismatch on callback (possible CSRF)"));
        return fail(new Error("callback missing authorization code"));
      }

      // Hold the response open; complete() flushes the body once the caller
      // knows whether the token exchange succeeded.
      res.writeHead(200, { "Content-Type": "text/plain" });
      pendingRes = res;
      res.on("close", () => {
        if (pendingRes === res) pendingRes = undefined;
      });
      succeed(parsed.code);
    });

    function settle(): boolean {
      if (settled) return false;
      settled = true;
      server.close();
      return true;
    }

    function fail(err: Error): void {
      if (settle()) rejectCode(err);
    }

    function succeed(code: string): void {
      if (settle()) resolveCode(code);
    }

    function complete(ok: boolean): void {
      if (completed) return;
      completed = true;
      const res = pendingRes;
      pendingRes = undefined;
      if (!res) return;
      try {
        res.end(ok ? SUCCESS_PAGE : FAILURE_PAGE);
      } catch {
        // Browser tab closed before flush.
      }
    }

    function closeHandle(): void {
      // Caller bailed (Ctrl-C) without calling complete(); flush a neutral
      // page so the browser tab doesn't hang.
      if (pendingRes && !completed) {
        completed = true;
        try {
          pendingRes.end(RETURNING_PAGE);
        } catch {
          // Browser tab closed.
        }
        pendingRes = undefined;
      }
      fail(new Error("login cancelled"));
    }

    server.on("error", (err) => {
      if (!listening) rejectServer(err);
      else fail(err);
    });

    server.listen(0, host, () => {
      listening = true;
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolveServer({
        redirectUri: redirectUriForPort(port, host),
        port,
        waitForCode: () => codePromise,
        complete,
        close: closeHandle,
      });
    });
  });
}
