import type { Command } from "commander";
import { resolveApiContext } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

interface AuthOpts {
  token?: string;
}

export function registerAuthCommand(parent: Command): void {
  const cmd = parent.command("auth").description("OAuth identity (login/logout flow lands with AINT-561)");

  cmd
    .command("login")
    .description("OAuth PKCE login flow (landing with AINT-561)")
    .action(() => runCommand("gusto auth login", readGlobalFlags(parent.opts()), authLoginHandler()));

  cmd
    .command("logout")
    .description("Revoke and drop the local token (landing with AINT-561)")
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
  return async () => ({
    ok: false,
    exitCode: ExitCode.General,
    error: {
      code: "deferred_to_ticket",
      message:
        "OAuth PKCE login flow lands with AINT-561. For V0.0.1, set GUSTO_ACCESS_TOKEN or pass --token to commands that hit the API.",
    },
  });
}

function authLogoutHandler(): CommandHandler {
  return async () => ({
    ok: false,
    exitCode: ExitCode.General,
    error: {
      code: "deferred_to_ticket",
      message: "Token revoke + persistence land with AINT-561. For V0.0.1, just unset GUSTO_ACCESS_TOKEN.",
    },
  });
}

function authWhoamiHandler(opts: AuthOpts): CommandHandler {
  return async ({ globals }) => {
    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, requireCompany: false });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.get("/v1/token_info");
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}
