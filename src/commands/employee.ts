import type { Command } from "commander";
import { ApiError } from "../lib/api-client.ts";
import { fetchResource, withCompanyContext } from "../lib/api-context.ts";
import { DRY_RUN_OPT, EXAMPLE_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, missingArgs, runCommand, runReadCommand, validationFailure } from "../lib/runner.ts";
import {
  missingEmployeeUuid,
  registerEmployeeAdd,
  registerEmployeeManage,
  withEmployeeClient,
  withEmployeeUuidArg,
} from "./employee-add.ts";

interface EmployeeListOpts {
  status?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
}

interface EmployeeShowOpts {
  tokenStdin?: boolean;
}

interface DeleteOpts {
  tokenStdin?: boolean;
  dryRun?: boolean;
  example?: boolean;
}

export function registerEmployeeCommand(parent: Command): void {
  const cmd = parent.command("employee").description("Add, inspect, and delete W-2 employees");

  registerEmployeeAdd(cmd, parent);
  registerEmployeeManage(cmd, parent);

  cmd
    .command("show <employee_uuid>")
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
    .command("list")
    .description("List company employees (active by default)")
    .option("--status <status>", "Which employees to list: active, onboarding, terminated, or all", "active")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
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

  withEmployeeUuidArg(cmd.command("delete"), "UUID of the employee to delete")
    .description("Delete a pre-onboarded employee")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((employeeUuid: string | undefined, opts: DeleteOpts) =>
      runCommand("gusto employee delete", readGlobalFlags(parent.opts()), employeeDeleteHandler(employeeUuid, opts)),
    );

  const job = cmd.command("job").description("Manage employee jobs");
  job
    .command("delete")
    .description("Delete a job (deactivates when hard-delete is blocked by dependencies)")
    .argument("[job_uuid]", "UUID of the job to delete")
    .option(...TOKEN_STDIN_OPT)
    .option(...DRY_RUN_OPT)
    .option(...EXAMPLE_OPT)
    .action((jobUuid: string | undefined, opts: DeleteOpts) =>
      runCommand("gusto employee job delete", readGlobalFlags(parent.opts()), jobDeleteHandler(jobUuid, opts)),
    );
}

export function employeeDeleteHandler(employeeUuid: string | undefined, opts: DeleteOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "DELETE",
          path: "/v1/employees/{employee_uuid}",
          note: "the API refuses to delete an onboarded employee (422 'Cannot delete onboarded employee')",
        },
      };
    }
    if (!employeeUuid) return missingEmployeeUuid();
    const path = `/v1/employees/${employeeUuid}`;
    if (opts.dryRun) return { ok: true, data: { method: "DELETE", path } };
    return withEmployeeClient(globals, opts.tokenStdin, async (client) => {
      await client.delete(path);
      return { ok: true, data: { deleted: true, employee_uuid: employeeUuid } };
    });
  };
}

export function jobDeleteHandler(jobUuid: string | undefined, opts: DeleteOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "DELETE",
          path: "/v1/jobs/{job_uuid}",
          note: "server returns 204 whether it hard-destroyed or fell back to deactivate; CLI follows up with a GET to distinguish",
        },
      };
    }
    if (!jobUuid) return missingArgs([{ field: "job_uuid", reason: "required" }]);
    const path = `/v1/jobs/${jobUuid}`;
    if (opts.dryRun) return { ok: true, data: { method: "DELETE", path } };
    return withEmployeeClient(globals, opts.tokenStdin, async (client) => {
      await client.delete(path);
      // 204 doesn't distinguish between hard-destroy and deactivate fallback
      // (employee_job.rb#destroy_or_deactivate). Follow up with GET: 404 means
      // destroyed; any 2xx means the row still exists, so deactivate fired.
      let action: "destroyed" | "deactivated" = "destroyed";
      try {
        await client.get(path);
        action = "deactivated";
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
      return { ok: true, data: { action, job_uuid: jobUuid } };
    });
  };
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
