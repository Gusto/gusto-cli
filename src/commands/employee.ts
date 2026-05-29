import type { Command } from "commander";
import { resolveApiContext } from "../lib/api-context.ts";
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
    if (!opts.firstName || !opts.lastName || !opts.email) {
      const blocked = [];
      if (!opts.firstName) blocked.push({ field: "first-name", reason: "required" });
      if (!opts.lastName) blocked.push({ field: "last-name", reason: "required" });
      if (!opts.email) blocked.push({ field: "email", reason: "required" });
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "validation", message: "missing required arguments", blocked_on: blocked },
      };
    }

    const body = {
      first_name: opts.firstName,
      last_name: opts.lastName,
      email: opts.email,
      ...(opts.role ? { job: { title: opts.role } } : {}),
      ...(opts.comp ? { compensation: parseComp(opts.comp) } : {}),
      self_onboarding: !opts.adminDriven,
    };

    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
    if (!ctx.ok) {
      if (opts.dryRun) {
        return {
          ok: true,
          data: {
            method: "POST",
            path: "/v1/companies/{company_uuid}/employees",
            body,
            note: "dry-run: token/company not required",
          },
        };
      }
      return ctx.result;
    }

    const path = `/v1/companies/${ctx.ctx.companyUuid}/employees`;
    if (opts.dryRun) {
      return { ok: true, data: { method: "POST", path, body } };
    }

    try {
      const response = await ctx.ctx.client.post(path, body);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
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

function parseComp(raw: string): { annual_salary?: number; hourly_rate?: number } {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return { annual_salary: 0 };
  return num >= 1000 ? { annual_salary: num } : { hourly_rate: num };
}
