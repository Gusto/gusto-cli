import type { Command } from "commander";
import { fetchCompanyResource, fetchResource } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, runReadCommand } from "../lib/runner.ts";

interface DepartmentListOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
}

interface DepartmentShowOpts {
  tokenStdin?: boolean;
}

export function registerDepartmentCommand(parent: Command): void {
  const cmd = parent.command("department").description("List and inspect company departments");

  cmd
    .command("show <department_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read a department record")
    .option(...TOKEN_STDIN_OPT)
    .action((departmentUuid: string, opts: DepartmentShowOpts) =>
      runReadCommand(
        "gusto department show",
        readGlobalFlags(parent.opts()),
        departmentShowHandler(departmentUuid, opts),
      ),
    );

  cmd
    .command("list")
    .description("List the company's departments")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .action((opts: DepartmentListOpts) =>
      runReadCommand("gusto department list", readGlobalFlags(parent.opts()), departmentListHandler(opts)),
    );
}

export function departmentListHandler(opts: DepartmentListOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/departments`,
    );
}

export function departmentShowHandler(departmentUuid: string, opts: DepartmentShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/departments/${encodeURIComponent(departmentUuid)}`);
}
