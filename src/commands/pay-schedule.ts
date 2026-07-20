import type { Command } from "commander";
import { fetchCompanyResource } from "../lib/api-context.ts";
import { CONFIRM_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { addPayScheduleOptions, type PayScheduleCreateOpts, payScheduleCreateHandler } from "../lib/pay-schedule.ts";
import type { BlockedOn } from "../lib/output.ts";
import { isValidIsoDate, validateEnum } from "../lib/parse.ts";
import { type QueryParams, toQueryString } from "../lib/query.ts";
import { type CommandHandler, runCommand, runReadCommand, validationFailure } from "../lib/runner.ts";

interface PayScheduleReadOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
}

// The pay_periods index silently returns an empty range for an unknown payroll_types
// value rather than erroring, so validate client-side to turn an agent's typo into an
// actionable blocked_on instead of a misleading empty result (mirrors `payroll list`).
const PAY_PERIOD_PAYROLL_TYPES = ["regular", "transition"] as const;

export interface PayPeriodsListOpts {
  startDate?: string;
  endDate?: string;
  payrollTypes?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
}

export type PayPeriodsQueryResult = { ok: true; query: QueryParams } | { ok: false; blocked: BlockedOn[] };

/** Map `pay-schedule periods` flags onto the API's `GET /v1/companies/{uuid}/pay_periods`
 * query params, validating that any supplied dates are ISO `YYYY-MM-DD` and that payroll_types
 * are recognized. The range rules (end_date at most 3 months out) are enforced server-side and
 * surfaced through the API error envelope, so they are intentionally not duplicated here. */
export function buildPayPeriodsQuery(opts: PayPeriodsListOpts): PayPeriodsQueryResult {
  const blocked: BlockedOn[] = [];
  if (opts.startDate !== undefined && !isValidIsoDate(opts.startDate)) {
    blocked.push({ field: "start-date", reason: "must be a valid date in YYYY-MM-DD format" });
  }
  if (opts.endDate !== undefined && !isValidIsoDate(opts.endDate)) {
    blocked.push({ field: "end-date", reason: "must be a valid date in YYYY-MM-DD format" });
  }
  const typeEntry = validateEnum("payroll-types", opts.payrollTypes, PAY_PERIOD_PAYROLL_TYPES, true);
  if (typeEntry) blocked.push(typeEntry);
  if (blocked.length > 0) return { ok: false, blocked };

  const query: QueryParams = {};
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined) query[key] = value;
  };
  set("start_date", opts.startDate);
  set("end_date", opts.endDate);
  set("payroll_types", opts.payrollTypes);
  return { ok: true, query };
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

  cmd
    .command("periods")
    .description("List the company's pay periods (the date windows payrolls cover)")
    .option("--start-date <date>", "Only pay periods on/after this date (YYYY-MM-DD; defaults to 6 months ago)")
    .option(
      "--end-date <date>",
      "Only pay periods up to this date (YYYY-MM-DD; at most 3 months out; defaults to today)",
    )
    .option(
      "--payroll-types <types>",
      `Pay-period types to include: ${PAY_PERIOD_PAYROLL_TYPES.join(", ")} - comma-separate (default regular)`,
    )
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto pay-schedule periods
  $ gusto pay-schedule periods --start-date 2026-01-01 --end-date 2026-03-31
  $ gusto pay-schedule periods --payroll-types regular,transition

Mirrors GET /v1/companies/{company}/pay_periods; the date-range rules are enforced server-side.
For the pay periods of terminated employees whose final payroll has not run, see
'gusto pay-schedule termination-periods'.
`,
    )
    .action((opts: PayPeriodsListOpts) =>
      runReadCommand("gusto pay-schedule periods", readGlobalFlags(parent.opts()), payPeriodsListHandler(opts)),
    );

  cmd
    .command("termination-periods")
    .description("List unprocessed pay periods for terminated employees (final payrolls not yet run)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Mirrors GET /v1/companies/{company}/pay_periods/unprocessed_termination_pay_periods.
Returns the pay periods for past and future terminated employees whose termination
payroll has not been processed yet.
`,
    )
    .action((opts: PayScheduleShowOpts) =>
      runReadCommand(
        "gusto pay-schedule termination-periods",
        readGlobalFlags(parent.opts()),
        terminationPeriodsHandler(opts),
      ),
    );
}

export function payPeriodsListHandler(opts: PayPeriodsListOpts): CommandHandler {
  return async ({ globals }) => {
    const parsed = buildPayPeriodsQuery(opts);
    if (!parsed.ok) return validationFailure("invalid arguments", parsed.blocked);
    return fetchCompanyResource(
      globals,
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/pay_periods${toQueryString(parsed.query)}`,
    );
  };
}

export function terminationPeriodsHandler(opts: PayScheduleShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/pay_periods/unprocessed_termination_pay_periods`,
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
