import type { Command } from "commander";
import { fetchResource } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { type Environment, type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import type { OAuthHttpOptions } from "../lib/oauth/endpoints.ts";
import { type SignInUrlEvent, type TokenInfo, companyUuidFromTokenInfo, login } from "../lib/oauth/login.ts";
import { revokeToken } from "../lib/oauth/revoke.ts";
import { parseScopes, summarizeGrantedScopes } from "../lib/oauth/scopes.ts";
import { type StreamSinks, resolveOutputMode } from "../lib/output.ts";
import { type TokenStore, resolveStore } from "../lib/oauth/token-store.ts";
import { hasClientCreds } from "../lib/oauth/types.ts";
import { type CommandHandler, runCommand, runReadCommand } from "../lib/runner.ts";

interface AuthOpts {
  tokenStdin?: boolean;
}

// commander negatable flag: `--no-browser` sets `browser: false` (default true).
interface LoginOpts {
  browser?: boolean;
}

export function registerAuthCommand(parent: Command): void {
  const cmd = parent.command("auth").description("OAuth identity (login, logout, whoami)");

  cmd
    .command("login")
    .description("Open the browser for OAuth PKCE login and store the token")
    .option(
      "--no-browser",
      "Print the sign-in URL instead of opening a browser (local headless use - the OAuth callback returns to 127.0.0.1 on this machine)",
    )
    .action((opts: LoginOpts) =>
      runCommand(
        "gusto auth login",
        readGlobalFlags(parent.opts()),
        authLoginHandler({ noBrowser: opts.browser === false }),
      ),
    );

  cmd
    .command("logout")
    .description("Revoke (best-effort) and clear the local token")
    .action(() => runCommand("gusto auth logout", readGlobalFlags(parent.opts()), authLogoutHandler()));

  cmd
    .command("whoami")
    .description("Show token identity + granted scopes via /v1/token_info")
    .option(...TOKEN_STDIN_OPT)
    .action((opts: AuthOpts) =>
      runReadCommand("gusto auth whoami", readGlobalFlags(parent.opts()), authWhoamiHandler(opts)),
    );
}

export interface LoginData {
  identity: NonNullable<TokenInfo["resource_owner"]>;
  company_uuid: string | null;
  scope?: string;
}

export function loginResultData(info: TokenInfo): LoginData {
  if (!info.resource_owner) throw new Error("login succeeded but token_info returned no identity");
  return { identity: info.resource_owner, company_uuid: companyUuidFromTokenInfo(info) ?? null, scope: info.scope };
}

/** Best-effort revoke (only if a usable session exists), then always clear local state. */
export async function performLogout(
  http: OAuthHttpOptions,
  store: TokenStore,
  env: Environment,
): Promise<{ revoked: boolean; note?: string }> {
  const session = await store.load(env);
  if (!session) return { revoked: false, note: "no stored session" };
  let revoked = false;
  if (session.accessToken && hasClientCreds(session)) {
    revoked = await revokeToken(http, session.accessToken, {
      clientId: session.clientId,
      clientSecret: session.clientSecret,
    });
  }
  await store.clear(env);
  return { revoked };
}

/** Agent mode (explicit --agent/--json OR auto-on when stdout is piped) gets a callback
 * that writes a JSON line for `login` to fire the moment the loopback server binds, before
 * blocking on the OAuth callback. Returns undefined in human mode so the URL is only printed. */
export function buildSignInUrlEmitter(
  globals: GlobalFlags,
  sinks: StreamSinks,
): ((event: SignInUrlEvent) => void) | undefined {
  if (resolveOutputMode(globals) !== "agent") return undefined;
  return (event) => sinks.stdout.write(`${JSON.stringify(event)}\n`);
}

export function authLoginHandler(opts: { noBrowser?: boolean } = {}): CommandHandler {
  return async ({ globals, sinks }) => {
    try {
      const info = await login(resolveEnv(globals), {
        store: resolveStore(),
        http: oauthHttp(globals),
        noBrowser: opts.noBrowser,
        emitEvent: buildSignInUrlEmitter(globals, sinks),
      });
      return { ok: true, data: loginResultData(info) };
    } catch (err) {
      return toResult(err);
    }
  };
}

function authLogoutHandler(): CommandHandler {
  return async ({ globals }) => {
    try {
      const data = await performLogout(oauthHttp(globals), resolveStore(), resolveEnv(globals));
      return { ok: true, data };
    } catch (err) {
      return toResult(err);
    }
  };
}

export function authWhoamiHandler(opts: AuthOpts): CommandHandler {
  // Token resolution (session > env > --token-stdin) is handled by fetchResource.
  return async ({ globals }) => {
    const result = await fetchResource<TokenInfo>(globals, { tokenStdin: opts.tokenStdin }, () => "/v1/token_info");
    if (!result.ok) return result;

    const info = result.data;
    return {
      ok: true,
      data: { ...info, capabilities: summarizeGrantedScopes(parseScopes(info?.scope)) },
    };
  };
}
