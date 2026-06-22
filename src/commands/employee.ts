import type { Command } from "commander";
import { ApiError } from "../lib/api-client.ts";
import { fetchResource, withCompanyContext } from "../lib/api-context.ts";
import { DRY_RUN_OPT, EXAMPLE_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { parsePaginationFlags } from "../lib/pagination.ts";
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
  cursor?: string;
  limit?: string;
  all?: boolean;
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
    .option("--cursor <token>", "Pagination cursor from a previous response's next value")
    .option("--limit <n>", "Maximum employees to return across pages")
    .option("--all", "Fetch every page (may issue multiple requests)")
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
breakdown) is included only when the result is complete (--all or a single full page).
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
      // The DELETE already returned 204; the row is gone (or deactivated). The
      // follow-up GET is a probe to distinguish the two branches of
      // employee_job.rb#destroy_or_deactivate (404 = destroyed, 2xx = deactivated).
      // If the probe fails for any other reason, we don't know which branch fired,
      // but the delete still succeeded — surface that as action="unknown" rather
      // than turning a successful delete into a non-ok envelope an agent would retry.
      let action: "destroyed" | "deactivated" | "unknown" = "unknown";
      try {
        await client.get(path);
        action = "deactivated";
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) action = "destroyed";
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
    const pg = parsePaginationFlags(opts);
    if (!pg.ok) return validationFailure(pg.message, pg.blocked);

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const { items, next, complete } = await ctx.client.paginate<EmployeeRecord>(
        `/v1/companies/${ctx.companyUuid}/employees`,
        pg.body,
      );
      return {
        ok: true,
        data: buildEmployeeList(items, parsed.status, complete),
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
 * active/onboarding/terminated breakdown in `summary` — included only when `complete`
 * (the walk reached the end), so a partial page's counts are never read as company totals.
 * A non-array body (empty or malformed 200) yields an empty list. */
export function buildEmployeeList(body: unknown, status: EmployeeStatus, complete: boolean): EmployeeListData {
  const employees = Array.isArray(body) ? (body as EmployeeRecord[]) : [];
  const buckets = bucketEmployees(employees);
  const selected = status === "all" ? employees : buckets[status];
  if (!complete) return { employees: selected };
  const summary: EmployeeListSummary = {
    total: employees.length,
    active: buckets.active.length,
    onboarding: buckets.onboarding.length,
    terminated: buckets.terminated.length,
    filter_applied: status,
  };
  return { summary, employees: selected };
}
