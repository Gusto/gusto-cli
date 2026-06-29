import type { Command } from "commander";
import { fetchCompanyResource, putCompanyResource } from "../lib/api-context.ts";
import { DRY_RUN_OPT, EXAMPLE_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { CsvError, parseCsv } from "../lib/csv.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { type GlobalFlags, readGlobalFlags } from "../lib/global-flags.ts";
import type { BlockedOn } from "../lib/output.ts";
import { isValidIsoDate, parseNonNegativeNumber } from "../lib/parse.ts";
import { type QueryParams, toQueryString } from "../lib/query.ts";
import { type CommandHandler, type CommandResult, missingArgs, runCommand, validationFailure } from "../lib/runner.ts";

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

// --- payroll update (CSV -> employee_compensations) -------------------------------------------
//
// `payroll update` writes per-cycle inputs onto a draft payroll via PUT
// /v1/companies/{uuid}/payrolls/{uuid}. The wire body is `{ employee_compensations: [...] }`
// (unwrapped - the API wraps it in `payroll` server-side). Each compensation is matched to an
// existing payroll line by its API `name`, so the column -> name map below uses the exact strings
// the Embedded API expects: 'Regular Hours' (ApiConstants::V1.regular_hours_compensation_name), the
// default 'Overtime' / 'Double overtime' pay-type names, and the 'Bonus' / 'Commission' /
// 'Paycheck Tips' / 'Cash Tips' earning-type names.

interface HourlyCompensationInput {
  name: string;
  hours: number;
  job_uuid?: string;
}

interface FixedCompensationInput {
  name: string;
  amount: number;
  job_uuid?: string;
}

interface ReimbursementInput {
  amount: number;
  description: string;
}

interface EmployeeCompensationUpdate {
  employee_uuid: string;
  version?: string;
  hourly_compensations?: HourlyCompensationInput[];
  fixed_compensations?: FixedCompensationInput[];
  reimbursements?: ReimbursementInput[];
}

export interface PayrollUpdateBody {
  employee_compensations: EmployeeCompensationUpdate[];
}

/** An employee whose row(s) carried no input values and so was left out of the update (the API
 * leaves untouched anyone not in the body). Reported back so a blank row in a master sheet is
 * visible, not silently dropped. */
export interface SkippedEmployee {
  employee_uuid: string;
  line: number;
}

/** Success carries the request body plus any employees skipped for having no inputs; failure keeps
 * the generic message + blocked_on shape so `validationFailure` can consume it directly. */
export type PayrollUpdateValidation =
  | { ok: true; body: PayrollUpdateBody; skipped: SkippedEmployee[] }
  | { ok: false; message: string; blocked: BlockedOn[] };

// Each hourly column maps to the API compensation `name` the PUT matches against. 'Regular Hours'
// is a stable, company-agnostic constant. 'Overtime' / 'Double overtime' are Gusto's default
// company pay-type names; the API matches the submitted name to a company pay type and silently
// drops any that doesn't match, so a company that has renamed its overtime pay type won't pick
// these up (called out in --help). Resolving renamed names is the agent's job, not the parser's.
const HOURLY_COLUMNS = [
  { column: "regular_hours", name: "Regular Hours" },
  { column: "overtime_hours", name: "Overtime" },
  { column: "double_overtime_hours", name: "Double overtime" },
] as const;
const FIXED_COLUMNS = [
  { column: "bonus", name: "Bonus" },
  { column: "commission", name: "Commission" },
  { column: "paycheck_tips", name: "Paycheck Tips" },
  { column: "cash_tips", name: "Cash Tips" },
] as const;
const REIMBURSEMENT_COLUMN = "reimbursement";
const SCALAR_COLUMNS = ["employee_uuid", "version", "job_uuid"] as const;
const INPUT_COLUMNS = [
  ...HOURLY_COLUMNS.map((c) => c.column),
  ...FIXED_COLUMNS.map((c) => c.column),
  REIMBURSEMENT_COLUMN,
];
const ALLOWED_COLUMNS = new Set<string>([...SCALAR_COLUMNS, ...INPUT_COLUMNS]);
const ALLOWED_COLUMNS_LIST = [...ALLOWED_COLUMNS].join(", ");

/** Header-level validation: every column must be known, `employee_uuid` must be present, and at
 * least one input column must exist. Unknown columns are treated as errors (not ignored) because a
 * typo'd header would otherwise silently drop an entire input - the same fail-loud stance the rest
 * of the CLI takes on bad enum tokens. */
function validatePayrollUpdateHeaders(headers: string[]): BlockedOn[] {
  const blocked: BlockedOn[] = [];
  const seen = new Set<string>();
  for (const h of headers) {
    if (seen.has(h)) blocked.push({ field: h, reason: `duplicate column "${h}"` });
    seen.add(h);
    if (!ALLOWED_COLUMNS.has(h)) {
      blocked.push({ field: h, reason: `unknown column "${h}"; allowed: ${ALLOWED_COLUMNS_LIST}` });
    }
  }
  if (!seen.has("employee_uuid")) blocked.push({ field: "employee_uuid", reason: "required column is missing" });
  if (!INPUT_COLUMNS.some((c) => seen.has(c))) {
    blocked.push({ field: "input", reason: `provide at least one input column: ${INPUT_COLUMNS.join(", ")}` });
  }
  return blocked;
}

/** One CSV data row's raw contribution: a single employee, optionally scoped to one job. Rows are
 * merged per employee afterwards (see mergeRowsByEmployee), so an employee with multiple jobs is
 * expressed as multiple rows (one per job) that fold into a single compensation. */
interface ParsedPayrollUpdateRow {
  line: number;
  employeeUuid: string;
  version?: string;
  jobUuid?: string;
  hourly: HourlyCompensationInput[];
  fixed: FixedCompensationInput[];
  reimbursements: ReimbursementInput[];
}

/** Parse each named numeric column from the row: skip blanks, push a `blocked_on` for a bad value,
 * and `build` an entry from each valid one. Shared by the hourly and fixed-comp columns so the two
 * can't drift. */
function parseNumericColumns<T>(
  columns: readonly { column: string; name: string }[],
  get: (column: string) => string,
  line: number,
  blocked: BlockedOn[],
  build: (name: string, value: number) => T,
): T[] {
  const out: T[] = [];
  for (const { column, name } of columns) {
    const raw = get(column);
    if (raw === "") continue;
    const parsed = parseNonNegativeNumber(raw);
    if (!parsed.ok) blocked.push({ field: `row ${line}: ${column}`, reason: parsed.reason });
    else out.push(build(name, parsed.value));
  }
  return out;
}

/** Parse one CSV row. Per-cell problems (bad numbers, too many cells) go on `blocked`; a row that
 * names an employee but carries no inputs goes on `skipped` instead of failing the import (a blank
 * row in a master sheet is expected). A blank cell is omitted (the API leaves omitted inputs
 * untouched); an explicit `0` is sent (overrides to zero). Returns null when the row yields no
 * usable contribution (whether errored or skipped). */
function parsePayrollUpdateRow(
  colIndex: Map<string, number>,
  headerCount: number,
  cells: string[],
  line: number,
  blocked: BlockedOn[],
  skipped: SkippedEmployee[],
): ParsedPayrollUpdateRow | null {
  if (cells.length > headerCount) {
    blocked.push({ field: `row ${line}`, reason: `has ${cells.length} cells but the header has ${headerCount}` });
    return null;
  }
  const get = (column: string): string => {
    const i = colIndex.get(column);
    return i !== undefined ? (cells[i] ?? "").trim() : "";
  };

  const employeeUuid = get("employee_uuid");
  if (!employeeUuid) {
    blocked.push({ field: `row ${line}: employee_uuid`, reason: "required" });
    return null;
  }

  const jobUuid = get("job_uuid");
  const job = jobUuid ? { job_uuid: jobUuid } : {};
  const errorsBefore = blocked.length;

  const hourly = parseNumericColumns(HOURLY_COLUMNS, get, line, blocked, (name, hours) => ({ name, hours, ...job }));
  const fixed = parseNumericColumns(FIXED_COLUMNS, get, line, blocked, (name, amount) => ({ name, amount, ...job }));

  const reimbursements: ReimbursementInput[] = [];
  const reimbRaw = get(REIMBURSEMENT_COLUMN);
  if (reimbRaw !== "") {
    const parsed = parseNonNegativeNumber(reimbRaw);
    if (!parsed.ok) blocked.push({ field: `row ${line}: ${REIMBURSEMENT_COLUMN}`, reason: parsed.reason });
    else reimbursements.push({ amount: parsed.value, description: "Reimbursement" });
  }

  // A row with no inputs is skipped (reported), not failed - unless a per-cell error already
  // explains why it produced nothing, in which case it stays an error.
  if (hourly.length === 0 && fixed.length === 0 && reimbursements.length === 0) {
    if (blocked.length === errorsBefore) skipped.push({ employee_uuid: employeeUuid, line });
    return null;
  }

  const version = get("version");
  return {
    line,
    employeeUuid,
    ...(version ? { version } : {}),
    ...(jobUuid ? { jobUuid } : {}),
    hourly,
    fixed,
    reimbursements,
  };
}

interface EmployeeGroup {
  employeeUuid: string;
  version?: string;
  versionLine?: number;
  hourly: HourlyCompensationInput[];
  fixed: FixedCompensationInput[];
  reimbursements: ReimbursementInput[];
  /** job_uuid ("" when a row omits it) -> the first line that used it, for duplicate detection. */
  jobLines: Map<string, number>;
}

/** Fold parsed rows into one employee_compensation per employee. Repeating an employee_uuid across
 * rows is how a multi-job employee splits hours over jobs, so it's allowed - but the same
 * (employee_uuid, job_uuid) pair twice is a genuine duplicate, and two different `version` values
 * for one employee can't be reconciled; both become blocked_on errors. */
function mergeRowsByEmployee(rows: ParsedPayrollUpdateRow[], blocked: BlockedOn[]): EmployeeCompensationUpdate[] {
  const groups = new Map<string, EmployeeGroup>();

  for (const row of rows) {
    let group = groups.get(row.employeeUuid);
    if (!group) {
      group = { employeeUuid: row.employeeUuid, hourly: [], fixed: [], reimbursements: [], jobLines: new Map() };
      groups.set(row.employeeUuid, group);
    }

    const jobKey = row.jobUuid ?? "";
    const firstLine = group.jobLines.get(jobKey);
    if (firstLine !== undefined) {
      const what = row.jobUuid ? "employee_uuid + job_uuid" : "employee_uuid (no job_uuid)";
      blocked.push({
        field: `row ${row.line}: employee_uuid`,
        reason: `duplicate ${what} (already on row ${firstLine}); use one row per employee-job`,
      });
      continue;
    }
    group.jobLines.set(jobKey, row.line);

    if (row.version) {
      if (group.version !== undefined && group.version !== row.version) {
        blocked.push({
          field: `row ${row.line}: version`,
          reason: `conflicting version for this employee (row ${group.versionLine} has a different value)`,
        });
        continue;
      }
      group.version = row.version;
      group.versionLine ??= row.line;
    }

    group.hourly.push(...row.hourly);
    group.fixed.push(...row.fixed);
    group.reimbursements.push(...row.reimbursements);
  }

  // Map preserves insertion order, so employees come out in first-seen order.
  return [...groups.values()].map((g) => ({
    employee_uuid: g.employeeUuid,
    ...(g.version ? { version: g.version } : {}),
    ...(g.hourly.length ? { hourly_compensations: g.hourly } : {}),
    ...(g.fixed.length ? { fixed_compensations: g.fixed } : {}),
    ...(g.reimbursements.length ? { reimbursements: g.reimbursements } : {}),
  }));
}

/** Parse a CSV of per-employee inputs into a payroll-update request body, accumulating every
 * structural, header, and per-row problem into a single blocked_on list (so one run surfaces all
 * the fixes, not just the first). Headers are lowercased so 'Employee_UUID' and 'employee_uuid'
 * both work. See HOURLY_COLUMNS/FIXED_COLUMNS for the column -> API-name map. */
export function buildPayrollUpdateFromCsv(text: string): PayrollUpdateValidation {
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (err) {
    const reason = err instanceof CsvError ? err.message : String(err);
    return { ok: false, message: "could not parse CSV", blocked: [{ field: "input", reason }] };
  }

  // Keep each row's 1-based file line before dropping blank rows, so `row N` in errors and the
  // skipped line numbers point at the real line even when blank lines precede a row.
  const nonBlank = rows.map((cells, i) => ({ cells, line: i + 1 })).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (nonBlank.length === 0) {
    return { ok: false, message: "empty CSV", blocked: [{ field: "input", reason: "the file has no rows" }] };
  }

  const headers = nonBlank[0].cells.map((h) => h.trim().toLowerCase());
  const headerBlocked = validatePayrollUpdateHeaders(headers);
  if (headerBlocked.length > 0) return { ok: false, message: "invalid CSV header", blocked: headerBlocked };

  // Resolve column positions once (headers are duplicate-free past validation) so per-cell lookups
  // are O(1) instead of a linear scan per access.
  const colIndex = new Map(headers.map((h, i) => [h, i] as const));
  const blocked: BlockedOn[] = [];
  const skippedRows: SkippedEmployee[] = [];
  const parsed: ParsedPayrollUpdateRow[] = [];
  for (const { cells, line } of nonBlank.slice(1)) {
    const row = parsePayrollUpdateRow(colIndex, headers.length, cells, line, blocked, skippedRows);
    if (row) parsed.push(row);
  }
  const employee_compensations = mergeRowsByEmployee(parsed, blocked);

  if (blocked.length > 0) return { ok: false, message: "invalid or incomplete CSV rows", blocked };

  // Report only employees with NO usable data anywhere - a blank row for someone who has data on
  // another row (e.g. their second job) is just padding, not a skip. One pass, deduping by uuid.
  const included = new Set(employee_compensations.map((c) => c.employee_uuid));
  const seen = new Set<string>();
  const skipped = skippedRows.filter((s) => {
    if (included.has(s.employee_uuid) || seen.has(s.employee_uuid)) return false;
    seen.add(s.employee_uuid);
    return true;
  });

  if (employee_compensations.length === 0) {
    const reason = skipped.length
      ? `every row had no input values (${skipped.length} employee(s) skipped)`
      : "no data rows after the header";
    return { ok: false, message: "nothing to update", blocked: [{ field: "input", reason }] };
  }
  return { ok: true, body: { employee_compensations }, skipped };
}

/** The canonical request/CSV shape published by `--example` - learnable without a uuid or auth.
 * Shows the multi-job pattern: the same employee on two rows (one per job) merges into a single
 * compensation. A job can carry more than one hourly entry - jobA here has both regular and
 * overtime hours. */
function payrollUpdateExample(): Record<string, unknown> {
  const jobA = "1f2e3d4c-0000-1111-2222-333344445555";
  const jobB = "2a3b4c5d-0000-1111-2222-333344445555";
  const employee = "9b8c7d6e-0000-1111-2222-333344445555";
  return {
    method: "PUT",
    path: "/v1/companies/{company_uuid}/payrolls/{payroll_uuid}",
    csv_columns: {
      required: ["employee_uuid"],
      optional: ["version", "job_uuid", ...INPUT_COLUMNS],
    },
    csv_example: [
      "employee_uuid,version,job_uuid,regular_hours,overtime_hours,bonus,cash_tips",
      `${employee},a1b2c3,${jobA},30,5,250,40`,
      `${employee},a1b2c3,${jobB},25,,,`,
    ].join("\n"),
    body: {
      employee_compensations: [
        {
          employee_uuid: employee,
          version: "a1b2c3",
          hourly_compensations: [
            { name: "Regular Hours", hours: 30, job_uuid: jobA },
            { name: "Overtime", hours: 5, job_uuid: jobA },
            { name: "Regular Hours", hours: 25, job_uuid: jobB },
          ],
          fixed_compensations: [
            { name: "Bonus", amount: 250, job_uuid: jobA },
            { name: "Cash Tips", amount: 40, job_uuid: jobA },
          ],
        },
      ],
    },
    note: "One CSV row per employee-job: repeat employee_uuid across rows to split hours over multiple jobs (rows merge into one compensation). Blank cells are left untouched; a 0 overrides to zero. A row with no input values is skipped and listed under `skipped_employees`, not failed. Hours (regular/overtime/double-overtime) and fixed comp (bonus/commission/tips) are replaced by name+job, but reimbursements are added on each run (not replaced), so set a reimbursement only once per cycle to avoid duplicates. overtime_hours/double_overtime_hours map to the default 'Overtime'/'Double overtime' pay types; if a company renamed its overtime pay type the API drops the unmatched line, so verify overtime on the prepared draft. Each employee's `version` comes from the prepared payroll (run `payroll prepare`, then read back each employee compensation's version). After updating, run `payroll prepare` to produce a reviewable draft.",
  };
}

interface PayrollUpdateOpts {
  input?: string;
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

  cmd
    .command("update [payroll_uuid]")
    .description(
      "Write per-employee inputs (tips, commission, bonus, reimbursement, regular hours) from a CSV onto a draft",
    )
    .option("--input <file>", "Path to a CSV of per-employee inputs (run --example to see the columns)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .addHelpText(
      "after",
      `
Updates an unprocessed (draft) payroll from a CSV. Columns (case-insensitive):
  employee_uuid (required), version, job_uuid,
  regular_hours, overtime_hours, double_overtime_hours,
  bonus, commission, paycheck_tips, cash_tips, reimbursement

One row per employee-job: repeat employee_uuid across rows to split hours over multiple jobs (the
rows merge into one compensation). Blank cells are left untouched; an explicit 0 overrides to zero.
Each row's 'version' is the optimistic-lock token from the prepared payroll. overtime_hours/double_overtime_hours use the default 'Overtime'/'Double overtime' pay types (a renamed pay type won't match, so verify it on the draft). After updating, run 'payroll prepare' to get a reviewable draft.

Examples:
  $ gusto payroll update 1a2b3c4d-0000-1111-2222-333344445555 --input inputs.csv
  $ gusto payroll update 1a2b... --input inputs.csv --dry-run
  $ gusto payroll update --example   (print the CSV columns and request shape, no uuid or auth)
`,
    )
    .action((payrollUuid: string | undefined, opts: PayrollUpdateOpts) =>
      runCommand("gusto payroll update", readGlobalFlags(parent.opts()), payrollUpdateHandler(payrollUuid, opts)),
    );
}

/** PUT to a payroll path with the UUID encoded as a single segment and the standard
 * token/company/dry-run options pulled from `opts`. Shared by prepare and update so the encoding
 * guard and option wiring can't drift. `suffix` is appended after the uuid (e.g. "/prepare").
 * Encoding matters: a raw `/`, `?` or `#` in a uuid from agent/tool output would otherwise retarget
 * the PUT (the client resolves paths via `new URL`), e.g. `x?e=1` dropping `/prepare`. */
function putPayrollResource(
  globals: GlobalFlags,
  payrollUuid: string,
  suffix: string,
  body: unknown,
  opts: { tokenStdin?: boolean; companyUuid?: string; dryRun?: boolean },
): Promise<CommandResult> {
  return putCompanyResource(globals, `payrolls/${encodeURIComponent(payrollUuid)}${suffix}`, body, {
    tokenStdin: opts.tokenStdin,
    companyUuid: opts.companyUuid,
    dryRun: opts.dryRun,
  });
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
    // prepare has no request body.
    return putPayrollResource(globals, payrollUuid, "/prepare", undefined, opts);
  };
}

/** True for a plain object (not null, not an array). Narrows `unknown` so the skipped_employees
 * merge can spread the API/dry-run data without a cast - an array would spread by numeric index. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `readFile` is injected so tests can drive the handler without touching the filesystem; it
 * defaults to Bun's native file read (the same seam company provision uses). */
export function payrollUpdateHandler(
  payrollUuid: string | undefined,
  opts: PayrollUpdateOpts,
  readFile: (path: string) => Promise<string> = (p) => Bun.file(p).text(),
): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) return { ok: true, data: payrollUpdateExample() };

    if (!payrollUuid || !opts.input) {
      const blocked: BlockedOn[] = [];
      if (!payrollUuid) blocked.push({ field: "payroll_uuid", reason: "required" });
      if (!opts.input)
        blocked.push({ field: "input", reason: "provide --input <file.csv> (or --example for the shape)" });
      return missingArgs(blocked);
    }

    let text: string;
    try {
      text = await readFile(opts.input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "invalid_input", message: `cannot read --input file ${opts.input}: ${message}` },
      };
    }

    const built = buildPayrollUpdateFromCsv(text);
    if (!built.ok) return validationFailure(built.message, built.blocked);

    const result = await putPayrollResource(globals, payrollUuid, "", built.body, opts);

    // Surface skipped (no-input) employees alongside the response so a blank row in a master sheet
    // is visible rather than silently dropped. Only attach when there are any and the data is a
    // plain object to extend (the API payroll on a real run, or the dry-run shape).
    if (result.ok && built.skipped.length > 0 && isRecord(result.data)) {
      return { ok: true, data: { ...result.data, skipped_employees: built.skipped } };
    }
    return result;
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
