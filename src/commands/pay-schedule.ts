import type { Command } from "commander";
import { fetchCompanyResource } from "../lib/api-context.ts";
import { CONFIRM_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { addPayScheduleOptions, type PayScheduleCreateOpts, payScheduleCreateHandler } from "../lib/pay-schedule.ts";
import { type CommandHandler, runCommand, runReadCommand } from "../lib/runner.ts";

interface PayScheduleReadOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
}

export function registerPayScheduleCommand(parent: Command): void {
  const cmd = parent.command("pay-schedule").description("Create and inspect pay schedules");

  addPayScheduleOptions(
    cmd.command("create").description("Create a pay schedule (handles Gusto's frequency + date-math rules)"),
  )
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option("--dry-run", "Build the request without sending")
    .option(...CONFIRM_OPT)
    .option("--example", "Print a canned sample payload without calling the API")
    .action((opts: PayScheduleCreateOpts) =>
      runCommand("gusto pay-schedule create", readGlobalFlags(parent.opts()), payScheduleCreateHandler(opts)),
    );

  cmd
    .command("list")
    .description("List active pay schedules for the company")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .action((opts: PayScheduleReadOpts) =>
      runReadCommand("gusto pay-schedule list", readGlobalFlags(parent.opts()), payScheduleListHandler(opts)),
    );

  cmd
    .command("assignments")
    .description("Show which pay schedule each employee/contractor is assigned to")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .action((opts: PayScheduleReadOpts) =>
      runReadCommand(
        "gusto pay-schedule assignments",
        readGlobalFlags(parent.opts()),
        payScheduleAssignmentsHandler(opts),
      ),
    );

  cmd
    .command("show <pay_schedule_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read a single pay schedule by UUID")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .action((payScheduleUuid: string, opts: PayScheduleReadOpts) =>
      runReadCommand(
        "gusto pay-schedule show",
        readGlobalFlags(parent.opts()),
        payScheduleShowHandler(payScheduleUuid, opts),
      ),
    );
}

export function payScheduleListHandler(opts: PayScheduleReadOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/pay_schedules`,
    );
}

export function payScheduleAssignmentsHandler(opts: PayScheduleReadOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/pay_schedules/assignments`,
    );
}

export function payScheduleShowHandler(payScheduleUuid: string, opts: PayScheduleReadOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/pay_schedules/${encodeURIComponent(payScheduleUuid)}`,
    );
}
