import type { Command } from "commander";
import { fetchAtPath, fetchResource, resolveApiContext, withCompanyContext } from "../lib/api-context.ts";
import { ALL_OPT, CURSOR_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { parsePaginationFlags } from "../lib/pagination.ts";
import { type CommandHandler, runReadCommand, validationFailure } from "../lib/runner.ts";

interface EmployeeListOpts {
  status?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
  cursor?: string;
  limit?: string;
  all?: boolean;
}

interface EmployeeShowOpts {
  tokenStdin?: boolean;
}

export function registerEmployeeCommand(parent: Command): void {
  const cmd = parent.command("employee").description("List and inspect W-2 employees");

  cmd
    .command("show <employee_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read employee record")
    .option(...TOKEN_STDIN_OPT)
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand("gusto employee show", readGlobalFlags(parent.opts()), employeeShowHandler(employeeUuid, opts)),
    );

  cmd
    .command("status <employee_uuid>")
    .description("Show onboarding status + the completed/required steps and any blockers")
    .option(...TOKEN_STDIN_OPT)
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee status",
        readGlobalFlags(parent.opts()),
        employeeStatusHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("addresses <employee_uuid>")
    .description("Read an employee's work and home addresses")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee addresses <employee_uuid>                      # work + home addresses
  $ gusto employee addresses <employee_uuid> --fields work_addresses   # just the work list

Returns both address lists under \`work_addresses\` and \`home_addresses\`. Each entry
carries its own UUID; pass it to \`employee work-address\`/\`home-address\` for a single record.
`,
    )
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee addresses",
        readGlobalFlags(parent.opts()),
        employeeAddressesHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("work-address <address_uuid>")
    .description("Read a single work address by UUID")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee work-address <address_uuid>   # one work address; UUIDs come from \`employee addresses\`
`,
    )
    .action((addressUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee work-address",
        readGlobalFlags(parent.opts()),
        workAddressHandler(addressUuid, opts),
      ),
    );

  cmd
    .command("home-address <address_uuid>")
    .description("Read a single home address by UUID")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee home-address <address_uuid>   # one home address; UUIDs come from \`employee addresses\`
`,
    )
    .action((addressUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee home-address",
        readGlobalFlags(parent.opts()),
        homeAddressHandler(addressUuid, opts),
      ),
    );

  cmd
    .command("list")
    .description("List company employees (active by default)")
    .option("--status <status>", "Which employees to list: active, onboarding, terminated, or all", "active")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...CURSOR_OPT)
    .option("--limit <n>", "Maximum employees to return across pages")
    .option(...ALL_OPT)
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee list                      # active employees, first page (100)
  $ gusto employee list --all                # every active employee, all pages
  $ gusto employee list --status all         # every record, first page
  $ gusto employee list --cursor <next>      # the next page, using a prior response's next

When more pages exist the response carries an opaque \`next\`; pass it back via --cursor,
or use --all to fetch everything. \`summary\` (the full active/onboarding/terminated
breakdown) is included only when the result is complete, so a partial page's counts are
never read as company totals.
`,
    )
    .action((opts: EmployeeListOpts) =>
      runReadCommand("gusto employee list", readGlobalFlags(parent.opts()), employeeListHandler(opts)),
    );
}

function employeeShowHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/employees/${employeeUuid}`);
}

function employeeStatusHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/employees/${employeeUuid}/onboarding_status`);
}

export function workAddressHandler(addressUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/work_addresses/${addressUuid}`);
}

export function homeAddressHandler(addressUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/home_addresses/${addressUuid}`);
}

// Two independent GETs on the employee-scoped (no company) path, combined under
// stable keys. Either failing fails the whole command; the single-address gets
// exist for granular access when one side errors.
export function employeeAddressesHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => {
    const resolved = await resolveApiContext(globals, { tokenStdin: opts.tokenStdin, requireCompany: false });
    if (!resolved.ok) return resolved.result;

    const work = await fetchAtPath(resolved.ctx.client, `/v1/employees/${employeeUuid}/work_addresses`);
    if (!work.ok) return work;
    const home = await fetchAtPath(resolved.ctx.client, `/v1/employees/${employeeUuid}/home_addresses`);
    if (!home.ok) return home;

    return { ok: true, data: { work_addresses: work.data, home_addresses: home.data } };
  };
}

export function employeeListHandler(opts: EmployeeListOpts): CommandHandler {
  return async ({ globals }) => {
    const parsed = parseStatus(opts.status);
    if (!parsed.ok) {
      return validationFailure("invalid --status", [{ field: "status", reason: parsed.reason }]);
    }
    const pg = parsePaginationFlags(opts);
    if (!pg.ok) return validationFailure(pg.message, pg.blocked);

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const { items, next, complete } = await ctx.client.paginate<EmployeeRecord>(
        `/v1/companies/${ctx.companyUuid}/employees`,
        pg.body,
      );
      // `complete` only means the walk reached the last page. A summary built from
      // `items` only reflects the whole roster when the walk also started at page 1;
      // a `--cursor <pageN>` resume that lands on the end would otherwise emit
      // counts that under-report by pages 1..N-1.
      const coversAll = complete && pg.body.startPage === 1;
      return {
        ok: true,
        data: buildEmployeeList(items, parsed.status, coversAll),
        next: pg.body.surfaceNext ? next : undefined,
      };
    });
  };
}

export type EmployeeStatus = "active" | "onboarding" | "terminated" | "all";

const EMPLOYEE_STATUSES: EmployeeStatus[] = ["active", "onboarding", "terminated", "all"];

export type StatusParseResult = { ok: true; status: EmployeeStatus } | { ok: false; reason: string };

/** Validate the --status value, defaulting to "active" when unset. */
export function parseStatus(raw: string | undefined): StatusParseResult {
  const value = raw ?? "active";
  if ((EMPLOYEE_STATUSES as string[]).includes(value)) return { ok: true, status: value as EmployeeStatus };
  return { ok: false, reason: `must be one of: ${EMPLOYEE_STATUSES.join(", ")}, got: ${value}` };
}

interface EmployeeRecord {
  terminated?: boolean;
  onboarding_status?: string;
  [key: string]: unknown;
}

export interface EmployeeBuckets {
  active: EmployeeRecord[];
  onboarding: EmployeeRecord[];
  terminated: EmployeeRecord[];
}

/** Partition employees into active / onboarding / terminated. Terminated takes
 * precedence; a non-terminated employee is active only once onboarding is complete. */
export function bucketEmployees(employees: EmployeeRecord[]): EmployeeBuckets {
  const buckets: EmployeeBuckets = { active: [], onboarding: [], terminated: [] };
  for (const employee of employees) {
    if (employee.terminated === true) {
      buckets.terminated.push(employee);
    } else if (employee.onboarding_status === "onboarding_completed") {
      buckets.active.push(employee);
    } else {
      buckets.onboarding.push(employee);
    }
  }
  return buckets;
}

export interface EmployeeListSummary {
  total: number;
  active: number;
  onboarding: number;
  terminated: number;
  filter_applied: EmployeeStatus;
}

export interface EmployeeListData {
  summary?: EmployeeListSummary;
  employees: EmployeeRecord[];
}

/** Shape the list response: the `--status` subset in `employees`, plus a full
 * active/onboarding/terminated breakdown in `summary` - included only when
 * `coversAll` is true, meaning `items` represents the entire company roster (the
 * walk started at page 1 *and* reached the end). A partial page or a cursor-resumed
 * walk yields `summary === undefined` so the partial counts are never mistaken for
 * company totals. A non-array body (empty or malformed 200) yields an empty list. */
export function buildEmployeeList(body: unknown, status: EmployeeStatus, coversAll: boolean): EmployeeListData {
  const employees = Array.isArray(body) ? (body as EmployeeRecord[]) : [];
  const buckets = bucketEmployees(employees);
  const selected = status === "all" ? employees : buckets[status];
  if (!coversAll) return { employees: selected };
  const summary: EmployeeListSummary = {
    total: employees.length,
    active: buckets.active.length,
    onboarding: buckets.onboarding.length,
    terminated: buckets.terminated.length,
    filter_applied: status,
  };
  return { summary, employees: selected };
}
