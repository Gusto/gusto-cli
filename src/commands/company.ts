import type { Command } from "commander";
import { resolveApiContext } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

interface CompanyShowOpts {
  companyUuid?: string;
  token?: string;
}

export function registerCompanyCommand(parent: Command): void {
  const cmd = parent.command("company").description("Provision, inspect, and finish company onboarding");

  cmd
    .command("provision")
    .description("Create a Gusto company programmatically (the wedge command - landing with AINT-562)")
    .option("--example", "Print a canned sample payload pre-auth")
    .option("--dry-run", "Build the request without sending")
    .action(() => runCommand("gusto company provision", readGlobalFlags(parent.opts()), companyProvisionHandler()));

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
  return async ({ globals }) => {
    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.get(`/v1/companies/${ctx.ctx.companyUuid}`);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}

function companyStatusHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) => {
    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.get(`/v1/companies/${ctx.ctx.companyUuid}/onboarding_status`);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}

function companyProvisionHandler(): CommandHandler {
  return async () => ({
    ok: false,
    exitCode: ExitCode.General,
    error: {
      code: "deferred_to_kickoff",
      message:
        "`gusto company provision` depends on the Mode 1 path picked at the 6/01 kickoff (Path B / C / A). Landing with AINT-562 once the path is locked.",
    },
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
