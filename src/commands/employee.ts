import type { Command } from "commander";
import { createCompanyResource, fetchResource, withCompanyContext } from "../lib/api-context.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import type { BlockedOn } from "../lib/output.ts";
import { parsePositiveNumber } from "../lib/parse.ts";
import { type CommandHandler, runCommand, runReadCommand, validationFailure } from "../lib/runner.ts";

interface EmployeeBody {
  first_name: string;
  last_name: string;
  email: string;
  job?: { title: string };
  compensation?: { annual_salary: number } | { hourly_rate: number };
  self_onboarding: boolean;
}

interface EmployeeAddOpts {
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: string;
  comp?: string;
  adminDriven?: boolean;
  companyUuid?: string;
  token?: string;
  dryRun?: boolean;
  example?: boolean;
}

interface EmployeeListOpts {
  status?: string;
  companyUuid?: string;
  token?: string;
}

interface EmployeeShowOpts {
  token?: string;
}

export function registerEmployeeCommand(parent: Command): void {
  const cmd = parent.command("employee").description("Add and inspect W-2 employees");

  cmd
    .command("add")
    .description("One-call W-2 onboarding (default: send invite so the employee self-onboards)")
    .option("--first-name <name>", "Employee first name")
    .option("--last-name <name>", "Employee last name")
    .option("--email <email>", "Employee email - also where the invite is sent")
    .option("--role <title>", "Job title")
    .option("--comp <amount>", "Compensation (annual salary if >= 1000, otherwise hourly rate)")
    .option("--admin-driven", "Caller supplies all employee data in-chat (default: self-onboard invite)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Build the request without sending")
    .option("--example", "Print a canned sample payload without calling the API")
    .addHelpText(
      "after",
      `
Examples:
  $ gusto employee add --first-name Jane --last-name Doe --email jane@example.com --role Engineer --comp 120000
  $ gusto employee add --first-name Jane --last-name Doe --email jane@example.com --dry-run

Required: --first-name, --last-name, --email. Missing args return a structured
\`blocked_on\` envelope (exit 7) so agents can retry with the missing fields.
`,
    )
    .action((opts: EmployeeAddOpts) =>
      runCommand("gusto employee add", readGlobalFlags(parent.opts()), employeeAddHandler(opts)),
    );

  cmd
    .command("show <employee_uuid>")
    .description("Read employee record")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((employeeUuid: string, opts: EmployeeShowOpts) =>
      runReadCommand("gusto employee show", readGlobalFlags(parent.opts()), employeeShowHandler(employeeUuid, opts)),
    );

  cmd
    .command("list")
    .description("List company employees (active by default)")
    .option("--status <status>", "Which employees to list: active, onboarding, terminated, or all", "active")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
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

function employeeAddHandler(opts: EmployeeAddOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/employees",
          body: {
            first_name: "Jane",
            last_name: "Doe",
            email: "jane@example.com",
            job: { title: "Engineer" },
            compensation: { annual_salary: 120000 },
            self_onboarding: true,
          },
          note: "example: canonical request shape, no args or auth required",
        },
      };
    }

    const { firstName, lastName, email } = opts;
    const blocked: BlockedOn[] = [];
    if (!firstName) blocked.push({ field: "first-name", reason: "required" });
    if (!lastName) blocked.push({ field: "last-name", reason: "required" });
    if (!email) blocked.push({ field: "email", reason: "required" });

    let compensation: { annual_salary: number } | { hourly_rate: number } | undefined;
    if (opts.comp !== undefined) {
      const parsed = parseComp(opts.comp);
      if (parsed.ok) {
        compensation = parsed.comp;
      } else {
        blocked.push({ field: "comp", reason: parsed.reason });
      }
    }

    if (!firstName || !lastName || !email || blocked.length > 0) {
      return validationFailure("missing or invalid arguments", blocked);
    }

    const body: EmployeeBody = {
      first_name: firstName,
      last_name: lastName,
      email,
      ...(opts.role ? { job: { title: opts.role } } : {}),
      ...(compensation ? { compensation } : {}),
      self_onboarding: !opts.adminDriven,
    };

    return createCompanyResource(globals, "employees", body, {
      token: opts.token,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
}

function employeeShowHandler(employeeUuid: string, opts: EmployeeShowOpts): CommandHandler {
  return async ({ globals }) => fetchResource(globals, { token: opts.token }, () => `/v1/employees/${employeeUuid}`);
}

export function employeeListHandler(opts: EmployeeListOpts): CommandHandler {
  return async ({ globals }) => {
    const parsed = parseStatus(opts.status);
    if (!parsed.ok) {
      return validationFailure("invalid --status", [{ field: "status", reason: parsed.reason }]);
    }

    return withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
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

export type CompParseResult =
  | { ok: true; comp: { annual_salary: number } | { hourly_rate: number } }
  | { ok: false; reason: string };

export function parseComp(raw: string): CompParseResult {
  const parsed = parsePositiveNumber(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const num = parsed.value;
  // Heuristic: values >= 1000 are interpreted as annual salary, smaller numbers as hourly rate.
  // Document this in --help in a future polish pass; for V0.0.1 it matches Gusto's convention.
  return { ok: true, comp: num >= 1000 ? { annual_salary: num } : { hourly_rate: num } };
}
