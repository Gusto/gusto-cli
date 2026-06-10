import type { Command } from "commander";
import { fetchResource, withCompanyContext } from "../lib/api-context.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, runReadCommand, validationFailure } from "../lib/runner.ts";
import { registerEmployeeAdd } from "./employee-add.ts";

interface EmployeeListOpts {
  status?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
}

interface EmployeeShowOpts {
  tokenStdin?: boolean;
}

export function registerEmployeeCommand(parent: Command): void {
  const cmd = parent.command("employee").description("Add and inspect W-2 employees");

  registerEmployeeAdd(cmd, parent);

  cmd
    .command("show <employee_uuid>")
    .description("Read employee record")
    .option("--token-stdin", "Read the access token from stdin (one line); for automation")
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand("gusto employee show", readGlobalFlags(parent.opts()), employeeShowHandler(employeeUuid, opts)),
    );

  cmd
    .command("status <employee_uuid>")
    .description("Show onboarding status + the completed/required steps and any blockers")
    .option("--token-stdin", "Read the access token from stdin (one line); for automation")
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand(
        "gusto employee status",
        readGlobalFlags(parent.opts()),
        employeeStatusHandler(employeeUuid, opts),
      ),
    );

  cmd
    .command("list")
    .description("List company employees (active by default)")
    .option("--status <status>", "Which employees to list: active, onboarding, terminated, or all", "active")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token-stdin", "Read the access token from stdin (one line); for automation")
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee list                      # active, payroll-ready employees (default)
  $ gusto employee list --status all         # every record
  $ gusto employee list --status onboarding  # not yet onboarded
  $ gusto employee list --status terminated

Every response carries a \`summary\` with the full active/onboarding/terminated
breakdown, so \`data.summary.total\` is the real headcount regardless of filter.
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

export function employeeListHandler(opts: EmployeeListOpts): CommandHandler {
  return async ({ globals }) => {
    const parsed = parseStatus(opts.status);
    if (!parsed.ok) {
      return validationFailure("invalid --status", [{ field: "status", reason: parsed.reason }]);
    }

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const response = await ctx.client.get(`/v1/companies/${ctx.companyUuid}/employees`);
      return { ok: true, data: buildEmployeeList(response.body, parsed.status) };
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
  summary: EmployeeListSummary;
  employees: EmployeeRecord[];
}

/** Shape the list response: a full breakdown in `summary` plus the `--status` subset
 * in `employees`. A non-array body (empty or malformed 200) yields zero counts. */
export function buildEmployeeList(body: unknown, status: EmployeeStatus): EmployeeListData {
  const employees = Array.isArray(body) ? (body as EmployeeRecord[]) : [];
  const buckets = bucketEmployees(employees);
  const summary: EmployeeListSummary = {
    total: employees.length,
    active: buckets.active.length,
    onboarding: buckets.onboarding.length,
    terminated: buckets.terminated.length,
    filter_applied: status,
  };
  if (status === "all") return { summary, employees };
  return { summary, employees: buckets[status] };
}
