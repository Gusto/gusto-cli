import type { Command } from "commander";
import { fetchCompanyResource, putCompanyResource } from "../lib/api-context.ts";
import { DRY_RUN_OPT, EXAMPLE_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import type { BlockedOn } from "../lib/output.ts";
import { isValidIsoDate } from "../lib/parse.ts";
import { type QueryParams, toQueryString } from "../lib/query.ts";
import { type CommandHandler, missingArgs, runCommand } from "../lib/runner.ts";

export interface PayrollListOpts {
  processingStatus?: string;
  payrollType?: string;
  startDate?: string;
  endDate?: string;
  dateFilterBy?: string;
  include?: string;
  sortOrder?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
}

export type PayrollListQueryResult = { ok: true; query: QueryParams } | { ok: false; blocked: BlockedOn[] };

// Closed enums, sourced from zenpayroll Api::V1::PayrollsController (the index
// endpoint's constants - deliberately NOT the public docs, which are stale: the
// docs omit `external` and list the SHOW-only `benefits`/`deductions` for
// `include`). The API silently returns an empty array for unknown enum values
// instead of erroring, so validating client-side turns an agent's typo into an
// actionable blocked_on instead of a misleading empty result.
const PROCESSING_STATUSES = ["processed", "unprocessed"] as const;
const PAYROLL_TYPES = ["regular", "off_cycle", "external"] as const;
const INCLUDE_OPTIONS = ["taxes", "payroll_status_meta", "totals", "risk_blockers", "reversals"] as const;
const SORT_ORDERS = ["asc", "desc"] as const;
// `check_date` is the only explicit value (omitting the flag defaults to pay
// period). The server already rejects unknown values with a 422, but validating
// here gives the same fast exit-7 blocked_on feedback as the other enums.
const DATE_FILTER_BY = ["check_date"] as const;

/** Validate a flag value against a closed enum, returning a `blocked_on` entry
 * for any unrecognized token (or null if all are valid). `multi` splits the
 * value on commas for the comma-separated multi-value params; empty tokens
 * (from trailing/double commas) are ignored. */
function validateEnum(
  field: string,
  value: string | undefined,
  allowed: readonly string[],
  multi: boolean,
): BlockedOn | null {
  if (value === undefined) return null;
  const tokens = (multi ? value.split(",") : [value]).filter((t) => t.length > 0);
  const invalid = tokens.filter((t) => !allowed.includes(t));
  if (invalid.length === 0) return null;
  return {
    field,
    reason: `invalid value(s) ${invalid.map((t) => `'${t}'`).join(", ")}; allowed: ${allowed.join(", ")}`,
  };
}

/** Map `payroll list` flags onto the API's `GET /v1/companies/{uuid}/payrolls`
 * query params, validating that any supplied dates are ISO `YYYY-MM-DD`. The
 * range rules (end_date at most 3 months out; start/end at most 1 year apart)
 * are enforced server-side and surfaced through the API error envelope, so they
 * are intentionally not duplicated here. The deprecated `processed` /
 * `include_off_cycle` params are omitted in favor of `processing_statuses` /
 * `payroll_types`. Pagination params (`page`/`per`) are not yet implemented. */
export function buildPayrollListQuery(opts: PayrollListOpts): PayrollListQueryResult {
  const blocked: BlockedOn[] = [];
  if (opts.startDate !== undefined && !isValidIsoDate(opts.startDate)) {
    blocked.push({ field: "start-date", reason: "must be a valid date in YYYY-MM-DD format" });
  }
  if (opts.endDate !== undefined && !isValidIsoDate(opts.endDate)) {
    blocked.push({ field: "end-date", reason: "must be a valid date in YYYY-MM-DD format" });
  }
  for (const entry of [
    validateEnum("processing-status", opts.processingStatus, PROCESSING_STATUSES, true),
    validateEnum("payroll-type", opts.payrollType, PAYROLL_TYPES, true),
    validateEnum("include", opts.include, INCLUDE_OPTIONS, true),
    validateEnum("sort-order", opts.sortOrder, SORT_ORDERS, false),
    validateEnum("date-filter-by", opts.dateFilterBy, DATE_FILTER_BY, false),
  ]) {
    if (entry) blocked.push(entry);
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

interface PayrollPrepareOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

export function registerPayrollCommand(parent: Command): void {
  const cmd = parent.command("payroll").description("Inspect and prepare payrolls");

  cmd
    .command("list")
    .description("List company payrolls (filter to past and/or future windows)")
    .option(
      "--processing-status <statuses>",
      `${PROCESSING_STATUSES.join(", ")} - comma-separate for multiple (default processed)`,
    )
    .option("--payroll-type <types>", `${PAYROLL_TYPES.join(", ")} - comma-separate for multiple (default regular)`)
    .option("--start-date <date>", "Only payrolls whose pay period is on/after this date (YYYY-MM-DD)")
    .option("--end-date <date>", "Only payrolls up to this date (YYYY-MM-DD; at most 3 months in the future)")
    .option("--date-filter-by <field>", "Date to filter by: check_date (defaults to pay period)")
    .option("--include <attrs>", `Include extra attributes: ${INCLUDE_OPTIONS.join(", ")} - comma-separate`)
    .option("--sort-order <order>", `${SORT_ORDERS.join(", ")} (default asc)`)
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
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

  cmd
    .command("prepare [payroll_uuid]")
    .description("Prepare a draft payroll: populates its employee compensations so totals can be verified")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .addHelpText(
      "after",
      `
A draft payroll starts as an empty shell (0 employee_compensations). Preparing it populates
them so the payroll's hours/compensations can be read back and verified - e.g. to confirm the
hours a 'timesheet sync' landed. Running payroll requires a prepared draft.

Examples:
  $ gusto payroll prepare 1a2b3c4d-0000-1111-2222-333344445555
  $ gusto payroll prepare --example   (print the request/response shape, no uuid or auth needed)
`,
    )
    .action((payrollUuid: string | undefined, opts: PayrollPrepareOpts) =>
      runCommand("gusto payroll prepare", readGlobalFlags(parent.opts()), payrollPrepareHandler(payrollUuid, opts)),
    );
}

export function payrollPrepareHandler(payrollUuid: string | undefined, opts: PayrollPrepareOpts): CommandHandler {
  return async ({ globals }) => {
    // --example publishes the path and canonical response shape without auth/company resolution, so
    // an agent can learn the command from `--help` without a real uuid or a live request.
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "PUT",
          path: "/v1/companies/{company_uuid}/payrolls/{payroll_uuid}/prepare",
          note: "no request body; response is the populated payroll. Read back employee_compensations to verify.",
        },
      };
    }
    if (!payrollUuid) return missingArgs([{ field: "payroll_uuid", reason: "required" }]);
    // Encode the UUID as a single path segment: the value can come from agent/tool output, and a
    // raw `/`, `?` or `#` would otherwise retarget the PUT (the client resolves paths via `new URL`,
    // which treats those as separators), e.g. `x?e=1` drops `/prepare` and hits the payroll-update
    // endpoint instead. Valid hex UUIDs are unaffected.
    // prepare has no request body; pass `undefined` to keep the body/opts arg order aligned with
    // createCompanyResource.
    return putCompanyResource(globals, `payrolls/${encodeURIComponent(payrollUuid)}/prepare`, undefined, {
      tokenStdin: opts.tokenStdin,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
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
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/payrolls${toQueryString(parsed.query)}`,
    );
  };
}
