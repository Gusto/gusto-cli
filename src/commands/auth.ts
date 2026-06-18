import type { Command } from "commander";
import { type StdinReader, type TokenSource, resolveApiContext } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { getAccessToken } from "../lib/env.ts";
import { type Environment, type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { type SignInUrlEvent, type TokenInfo, companyUuidFromTokenInfo, login } from "../lib/oauth/login.ts";
import { parseScopes, summarizeGrantedScopes } from "../lib/oauth/scopes.ts";
import { type StreamSinks, resolveOutputMode } from "../lib/output.ts";
import { type TokenStore, resolveStore } from "../lib/oauth/token-store.ts";
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
    .description("Clear the locally stored OAuth session")
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

export async function performLogout(store: TokenStore, env: Environment): Promise<{ cleared: boolean }> {
  const session = await store.load(env);
  if (!session) return { cleared: false };
  await store.clear(env);
  return { cleared: true };
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

/** The login transport, injectable so handler tests don't drive the real OAuth flow. */
type LoginFn = (env: Environment, deps: Parameters<typeof login>[1]) => Promise<TokenInfo>;

export interface AuthLoginDeps {
  login?: LoginFn;
}

export function authLoginHandler(opts: { noBrowser?: boolean } = {}, deps: AuthLoginDeps = {}): CommandHandler {
  const doLogin = deps.login ?? login;
  return async ({ globals, sinks }) => {
    // A set GUSTO_ACCESS_TOKEN outranks the session we're about to store, so every
    // later command would run as the env token's identity, not this login's. Warn
    // (gh refuses `--with-token` under GITHUB_TOKEN for the same reason) so the user
    // isn't misled about which identity is active.
    if (getAccessToken()) {
      sinks.stderr.write(
        "warning: GUSTO_ACCESS_TOKEN is set and overrides the stored login. Commands will use that token, not this session. Unset it to use the logged-in identity.\n",
      );
    }
    try {
      const info = await doLogin(resolveEnv(globals), {
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
      const data = await performLogout(resolveStore(), resolveEnv(globals));
      return { ok: true, data };
    } catch (err) {
      return toResult(err);
    }
  };
}

/** Human-facing name for each credential source, matching how a user supplies it. */
const CREDENTIAL_SOURCE_LABEL: Record<TokenSource, string> = {
  stdin: "--token-stdin",
  env: "GUSTO_ACCESS_TOKEN",
  session: "stored session",
};

export function authWhoamiHandler(opts: AuthOpts, readStdin?: StdinReader): CommandHandler {
  return async ({ globals }) => {
    const resolved = await resolveApiContext(globals, {
      requireCompany: false,
      tokenStdin: opts.tokenStdin,
      readStdin,
    });
    if (!resolved.ok) return resolved.result;

    try {
      const response = await resolved.ctx.client.get<TokenInfo>("/v1/token_info");
      const info = response.body;
      return {
        ok: true,
        data: {
          ...info,
          credential_source: CREDENTIAL_SOURCE_LABEL[resolved.ctx.tokenSource],
          capabilities: summarizeGrantedScopes(parseScopes(info?.scope)),
        },
      };
    } catch (err) {
      return toResult(err);
    }
  };
}
