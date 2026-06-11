import type { Command } from "commander";
import { fetchResource } from "../lib/api-context.ts";
import { getAccessToken } from "../lib/env.ts";
import { type Environment, readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import type { OAuthHttpOptions } from "../lib/oauth/endpoints.ts";
import { type TokenInfo, companyUuidFromTokenInfo, login } from "../lib/oauth/login.ts";
import { revokeToken } from "../lib/oauth/revoke.ts";
import { getValidUserToken } from "../lib/oauth/session.ts";
import { type TokenStore, resolveStore } from "../lib/oauth/token-store.ts";
import { hasClientCreds } from "../lib/oauth/types.ts";
import { type CommandHandler, runCommand, runReadCommand } from "../lib/runner.ts";

interface AuthOpts {
  token?: string;
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
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
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

/** An explicit override (--token / GUSTO_ACCESS_TOKEN) wins; otherwise the stored user token. */
export function resolveWhoamiToken(
  http: OAuthHttpOptions,
  store: TokenStore,
  env: Environment,
  override: string | null,
): Promise<string | null> {
  if (override) return Promise.resolve(override);
  return getValidUserToken(store, env, http);
}

function authLoginHandler(opts: { noBrowser?: boolean } = {}): CommandHandler {
  return async ({ globals }) => {
    try {
      const info = await login(resolveEnv(globals), {
        store: resolveStore(),
        http: oauthHttp(globals),
        noBrowser: opts.noBrowser,
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

function authWhoamiHandler(opts: AuthOpts): CommandHandler {
  return async ({ globals }) => {
    let token: string | undefined;
    try {
      token =
        (await resolveWhoamiToken(
          oauthHttp(globals),
          resolveStore(),
          resolveEnv(globals),
          getAccessToken(opts.token),
        )) ?? undefined;
    } catch (err) {
      return toResult(err);
    }
    return fetchResource(globals, { token }, () => "/v1/token_info");
  };
}
