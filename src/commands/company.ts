import type { Command } from "commander";
import { fetchCompanyResource } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { companyUuidFromTokenInfo, defaultOpenBrowser } from "../lib/oauth/login.ts";
import { provision } from "../lib/oauth/provision.ts";
import { InputError, resolveProvisionPayload } from "../lib/oauth/provision-input.ts";
import { resolveStore } from "../lib/oauth/token-store.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

interface CompanyShowOpts {
  companyUuid?: string;
  token?: string;
}

interface ProvisionOpts {
  input?: string;
  example?: boolean;
  dryRun?: boolean;
}

export function registerCompanyCommand(parent: Command): void {
  const cmd = parent.command("company").description("Provision, inspect, and finish company onboarding");

  cmd
    .command("provision")
    .description("Create a Gusto company programmatically (the wedge command)")
    .option("--input <file>", "Path to a JSON file with the {user, company} payload")
    .option("--example", "Use the canned sample payload")
    .option("--dry-run", "Build the request without sending")
    .action((opts: ProvisionOpts) =>
      runCommand("gusto company provision", readGlobalFlags(parent.opts()), companyProvisionHandler(opts)),
    );

  cmd
    .command("status")
    .description("Show onboarding status + structured blocked_on list")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: CompanyShowOpts) =>
      runCommand("gusto company status", readGlobalFlags(parent.opts()), companyStatusHandler(opts)),
    );

  cmd
    .command("show")
    .description("Read company record (legal name, EIN, entity type, addresses)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: CompanyShowOpts) =>
      runCommand("gusto company show", readGlobalFlags(parent.opts()), companyShowHandler(opts)),
    );

  cmd
    .command("finish")
    .description("Transition to onboarded (endpoint TBD - landing with AINT-562)")
    .action(() => runCommand("gusto company finish", readGlobalFlags(parent.opts()), companyFinishHandler()));
}

function companyShowHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { token: opts.token, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}`,
    );
}

function companyStatusHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { token: opts.token, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/onboarding_status`,
    );
}

function companyProvisionHandler(opts: ProvisionOpts): CommandHandler {
  return async ({ globals }) => {
    let payload;
    try {
      payload = await resolveProvisionPayload({ input: opts.input, example: opts.example }, (p) => Bun.file(p).text());
    } catch (err) {
      if (err instanceof InputError) {
        return { ok: false, exitCode: ExitCode.Validation, error: { code: "invalid_input", message: err.message } };
      }
      return toResult(err);
    }

    if (opts.dryRun) {
      return { ok: true, data: { method: "POST", path: "/v1/provision", body: payload } };
    }

    try {
      const env = resolveEnv(globals);
      const store = resolveStore();
      const result = await provision(env, payload, {
        store,
        http: oauthHttp(globals),
        openBrowser: defaultOpenBrowser,
        confirmClaim: process.stdin.isTTY ? waitForEnter : undefined,
      });
      return {
        ok: true,
        data: {
          account_claim_url: result.accountClaimUrl,
          company_uuid: companyUuidFromTokenInfo(result.tokenInfo) ?? null,
        },
      };
    } catch (err) {
      return toResult(err);
    }
  };
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write("Press Enter once you've finished claiming the account in your browser...");
    const done = (): void => {
      process.stdin.pause();
      process.stdin.off("data", done);
      process.stdin.off("end", done);
      process.stdin.off("close", done);
      resolve();
    };
    process.stdin.resume();
    // Also resolve on end/close so a closed/EOF stdin (even a disconnected TTY)
    // doesn't hang the flow waiting for a 'data' event that never comes.
    process.stdin.once("data", done);
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });
}

function companyFinishHandler(): CommandHandler {
  return async () => ({
    ok: false,
    exitCode: ExitCode.General,
    error: {
      code: "endpoint_unknown",
      message:
        "`gusto company finish` is deferred - the finalize endpoint depends on the Mode 1 path. Landing with AINT-562.",
    },
  });
}
