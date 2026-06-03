import type { Command } from "commander";
import { fetchResource } from "../lib/api-context.ts";
import { getAccessToken } from "../lib/env.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { companyUuidFromTokenInfo, login } from "../lib/oauth/login.ts";
import { revokeToken } from "../lib/oauth/revoke.ts";
import { getValidUserToken } from "../lib/oauth/session.ts";
import { resolveStore } from "../lib/oauth/token-store.ts";
import { hasClientCreds } from "../lib/oauth/types.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";
import { toResult } from "../lib/handle-api-error.ts";

interface AuthOpts {
  token?: string;
}

export function registerAuthCommand(parent: Command): void {
  const cmd = parent.command("auth").description("OAuth identity (login, logout, whoami)");

  cmd
    .command("login")
    .description("Open the browser for OAuth PKCE login and store the token")
    .action(() => runCommand("gusto auth login", readGlobalFlags(parent.opts()), authLoginHandler()));

  cmd
    .command("logout")
    .description("Revoke (best-effort) and clear the local token")
    .action(() => runCommand("gusto auth logout", readGlobalFlags(parent.opts()), authLogoutHandler()));

  cmd
    .command("whoami")
    .description("Show token identity + granted scopes via /v1/token_info")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: AuthOpts) =>
      runCommand("gusto auth whoami", readGlobalFlags(parent.opts()), authWhoamiHandler(opts)),
    );
}

function authLoginHandler(): CommandHandler {
  return async ({ globals }) => {
    try {
      const env = resolveEnv(globals);
      const store = resolveStore();
      const info = await login(env, { store, http: oauthHttp(globals) });
      return {
        ok: true,
        data: {
          identity: info.resource_owner,
          company_uuid: companyUuidFromTokenInfo(info) ?? null,
          scope: info.scope,
        },
      };
    } catch (err) {
      return toResult(err);
    }
  };
}

function authLogoutHandler(): CommandHandler {
  return async ({ globals }) => {
    try {
      const env = resolveEnv(globals);
      const store = resolveStore();
      const session = await store.load(env);
      if (!session) {
        return { ok: true, data: { revoked: false, note: "no stored session" } };
      }
      let revoked = false;
      if (session.accessToken && hasClientCreds(session)) {
        revoked = await revokeToken(oauthHttp(globals), session.accessToken, {
          clientId: session.clientId,
          clientSecret: session.clientSecret,
        });
      }
      await store.clear(env);
      return { ok: true, data: { revoked } };
    } catch (err) {
      return toResult(err);
    }
  };
}

function authWhoamiHandler(opts: AuthOpts): CommandHandler {
  return async ({ globals }) => {
    const override = getAccessToken(opts.token);
    let token = override ?? undefined;
    if (!token) {
      try {
        const env = resolveEnv(globals);
        const store = resolveStore();
        token = (await getValidUserToken(store, env, oauthHttp(globals))) ?? undefined;
      } catch (err) {
        return toResult(err);
      }
    }
    return fetchResource(globals, { token }, () => "/v1/token_info");
  };
}
