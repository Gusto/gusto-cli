import type { Command } from "commander";
import { fetchCompanyResource } from "../lib/api-context.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { addPayScheduleOptions, type PayScheduleCreateOpts, payScheduleCreateHandler } from "../lib/pay-schedule.ts";
import { type CommandHandler, runCommand, runReadCommand } from "../lib/runner.ts";

interface PayScheduleShowOpts {
  companyUuid?: string;
  token?: string;
}

export function registerPayScheduleCommand(parent: Command): void {
  const cmd = parent.command("pay-schedule").description("Create and inspect pay schedules");

  addPayScheduleOptions(
    cmd.command("create").description("Create a pay schedule (handles Gusto's frequency + date-math rules)"),
  )
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Build the request without sending")
    .option("--example", "Print a canned sample payload without calling the API")
    .action((opts: PayScheduleCreateOpts) =>
      runCommand("gusto pay-schedule create", readGlobalFlags(parent.opts()), payScheduleCreateHandler(opts)),
    );

  cmd
    .command("show")
    .description("List active pay schedules for the company")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: PayScheduleShowOpts) =>
      runReadCommand("gusto pay-schedule show", readGlobalFlags(parent.opts()), payScheduleShowHandler(opts)),
    );
}

function payScheduleShowHandler(opts: PayScheduleShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { token: opts.token, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/pay_schedules`,
    );
}
