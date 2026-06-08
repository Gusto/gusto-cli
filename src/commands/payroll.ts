import type { Command } from "commander";
import { fetchCompanyResource } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import type { BlockedOn } from "../lib/output.ts";
import { type QueryParams, toQueryString } from "../lib/query.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

export interface PayrollListOpts {
  processingStatus?: string;
  payrollType?: string;
  startDate?: string;
  endDate?: string;
  dateFilterBy?: string;
  include?: string;
  sortOrder?: string;
  companyUuid?: string;
  token?: string;
}

export type PayrollListQueryResult = { ok: true; query: QueryParams } | { ok: false; blocked: BlockedOn[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in `YYYY-MM-DD` form (rejects bad formats and
 * impossible dates like 2026-02-30). */
function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** Map `payroll list` flags onto the API's `GET /v1/companies/{uuid}/payrolls`
 * query params, validating that any supplied dates are ISO `YYYY-MM-DD`. The
 * range rules (end_date at most 3 months out; start/end at most 1 year apart)
 * are enforced server-side and surfaced through the API error envelope, so they
 * are intentionally not duplicated here. The deprecated `processed` /
 * `include_off_cycle` params are omitted in favor of `processing_statuses` /
 * `payroll_types`. Pagination params (`page`/`per`) are deferred to AINT-564. */
export function buildPayrollListQuery(opts: PayrollListOpts): PayrollListQueryResult {
  const blocked: BlockedOn[] = [];
  if (opts.startDate !== undefined && !isValidIsoDate(opts.startDate)) {
    blocked.push({ field: "start-date", reason: "must be a valid date in YYYY-MM-DD format" });
  }
  if (opts.endDate !== undefined && !isValidIsoDate(opts.endDate)) {
    blocked.push({ field: "end-date", reason: "must be a valid date in YYYY-MM-DD format" });
  }
  if (blocked.length > 0) return { ok: false, blocked };

  const query: QueryParams = {};
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined) query[key] = value;
  };
  set("processing_statuses", opts.processingStatus);
  set("payroll_types", opts.payrollType);
  set("start_date", opts.startDate);
  set("end_date", opts.endDate);
  set("date_filter_by", opts.dateFilterBy);
  set("include", opts.include);
  set("sort_order", opts.sortOrder);
  return { ok: true, query };
}

export function registerPayrollCommand(parent: Command): void {
  const cmd = parent.command("payroll").description("Inspect payrolls");

  cmd
    .command("list")
    .description("List company payrolls (filter to past and/or future windows)")
    .option(
      "--processing-status <statuses>",
      "processed, unprocessed - comma-separate for multiple (default processed)",
    )
    .option("--payroll-type <types>", "regular, off_cycle - comma-separate for multiple (default regular)")
    .option("--start-date <date>", "Only payrolls whose pay period is on/after this date (YYYY-MM-DD)")
    .option("--end-date <date>", "Only payrolls up to this date (YYYY-MM-DD; at most 3 months in the future)")
    .option("--date-filter-by <field>", "Date to filter by: check_date (defaults to pay period)")
    .option("--include <attrs>", "Include extra attributes: benefits, deductions, taxes - comma-separate")
    .option("--sort-order <order>", "asc or desc (default asc)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .addHelpText(
      "after",
      `
Examples:
  $ gusto payroll list --processing-status processed --start-date 2026-01-01 --end-date 2026-03-31
  $ gusto payroll list --payroll-type regular,off_cycle --sort-order desc

All filters are optional. Defaults: processed regular payrolls, ascending.
`,
    )
    .action((opts: PayrollListOpts) =>
      runCommand("gusto payroll list", readGlobalFlags(parent.opts()), payrollListHandler(opts)),
    );
}

function payrollListHandler(opts: PayrollListOpts): CommandHandler {
  return async ({ globals }) => {
    const parsed = buildPayrollListQuery(opts);
    if (!parsed.ok) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "validation", message: "invalid arguments", blocked_on: parsed.blocked },
      };
    }

    return fetchCompanyResource(
      globals,
      { token: opts.token, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/payrolls${toQueryString(parsed.query)}`,
    );
  };
}
