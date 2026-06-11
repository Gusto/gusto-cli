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
  /** Render the final browser page once the caller knows the real outcome. The
   * loopback holds the callback response open until this is called so the user
   * never sees "login complete" before the token exchange has actually succeeded.
   * Safe to call once; subsequent calls are no-ops. Calling `close()` without
   * `complete()` finishes the response with a neutral "Returning to CLI..." page. */
  complete(result: { ok: boolean; message?: string }): void;
  close(): void;
}

/** A neutral page rendered the instant the loopback receives the callback. The
 * outcome is unknown at this point - the token exchange hasn't happened yet -
 * so we deliberately avoid claiming success. `complete()` flips this to a real
 * pass/fail message once the caller knows. */
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
      const validCallback = parsed.code != null && parsed.error == null && parsed.state === expectedState;

      if (!validCallback) {
        // Fail fast on the wire - no need to hold the connection open. Caller
        // hasn't started a token exchange yet because there's no code to use.
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Gusto CLI: login failed. Return to your terminal.");
        if (parsed.error) return fail(new Error(`authorization failed: ${parsed.error}`));
        if (parsed.state !== expectedState) return fail(new Error("state mismatch on callback (possible CSRF)"));
        return fail(new Error("callback missing authorization code"));
      }

      // Hold the response open until the caller signals the real outcome via
      // complete(). Stream the headers + a "returning" body so the browser tab
      // isn't blank while the token exchange runs.
      res.writeHead(200, { "Content-Type": "text/plain" });
      pendingRes = res;
      res.on("close", () => {
        // Browser closed early; drop the handle so complete() can't write to it.
        if (pendingRes === res) pendingRes = undefined;
      });
      succeed(parsed.code as string);
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

    function complete(result: { ok: boolean; message?: string }): void {
      if (completed) return;
      completed = true;
      const res = pendingRes;
      pendingRes = undefined;
      if (!res) return;
      const body =
        result.message ??
        (result.ok
          ? "Gusto CLI: login complete. You can close this tab."
          : "Gusto CLI: login failed. Return to your terminal.");
      try {
        res.end(body);
      } catch {
        // Browser tab closed; nothing to write to.
      }
    }

    function closeHandle(): void {
      // If the caller is bailing without ever calling complete(), flush a
      // neutral page so the browser tab doesn't hang on a half-written response.
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
