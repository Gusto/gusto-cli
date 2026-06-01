import type { Command } from "commander";
import { createCompanyResource, resolveApiContext } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

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
      runCommand("gusto employee show", readGlobalFlags(parent.opts()), employeeShowHandler(employeeUuid, opts)),
    );

  cmd
    .command("list")
    .description("List company employees")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: EmployeeListOpts) =>
      runCommand("gusto employee list", readGlobalFlags(parent.opts()), employeeListHandler(opts)),
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

    const blocked: { field: string; reason: string }[] = [];
    if (!opts.firstName) blocked.push({ field: "first-name", reason: "required" });
    if (!opts.lastName) blocked.push({ field: "last-name", reason: "required" });
    if (!opts.email) blocked.push({ field: "email", reason: "required" });

    let compensation: { annual_salary: number } | { hourly_rate: number } | undefined;
    if (opts.comp !== undefined) {
      const parsed = parseComp(opts.comp);
      if (parsed.ok) {
        compensation = parsed.comp;
      } else {
        blocked.push({ field: "comp", reason: parsed.reason });
      }
    }

    if (blocked.length > 0) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "validation", message: "missing or invalid arguments", blocked_on: blocked },
      };
    }

    const body = {
      first_name: opts.firstName,
      last_name: opts.lastName,
      email: opts.email,
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
  return async ({ globals }) => {
    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, requireCompany: false });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.get(`/v1/employees/${employeeUuid}`);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}

function employeeListHandler(opts: EmployeeListOpts): CommandHandler {
  return async ({ globals }) => {
    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.get(`/v1/companies/${ctx.ctx.companyUuid}/employees`);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}

export type CompParseResult =
  | { ok: true; comp: { annual_salary: number } | { hourly_rate: number } }
  | { ok: false; reason: string };

export function parseComp(raw: string): CompParseResult {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, reason: `must be a positive number, got: ${raw}` };
  }
  // Heuristic: values >= 1000 are interpreted as annual salary, smaller numbers as hourly rate.
  // Document this in --help in a future polish pass; for V0.0.1 it matches Gusto's convention.
  return { ok: true, comp: num >= 1000 ? { annual_salary: num } : { hourly_rate: num } };
}
