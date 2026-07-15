import type { Command } from "commander";
import { fetchResource, withCompanyContext } from "../lib/api-context.ts";
import { ALL_OPT, CURSOR_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { parsePaginationFlags } from "../lib/pagination.ts";
import { type CommandHandler, runReadCommand, validationFailure } from "../lib/runner.ts";

interface ContractorListOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
  cursor?: string;
  limit?: string;
  all?: boolean;
}

interface ContractorShowOpts {
  tokenStdin?: boolean;
}

export function registerContractorCommand(parent: Command): void {
  const cmd = parent.command("contractor").description("List and inspect 1099 contractors");

  cmd
    .command("show <contractor_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read contractor record")
    .option(...TOKEN_STDIN_OPT)
    .action((contractorUuid: string, opts: ContractorShowOpts) =>
      runReadCommand(
        "gusto contractor show",
        readGlobalFlags(parent.opts()),
        contractorShowHandler(contractorUuid, opts),
      ),
    );

  cmd
    .command("list")
    .description("List company contractors")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...CURSOR_OPT)
    .option("--limit <n>", "Maximum contractors to return across pages")
    .option(...ALL_OPT)
    .action((opts: ContractorListOpts) =>
      runReadCommand("gusto contractor list", readGlobalFlags(parent.opts()), contractorListHandler(opts)),
    );
}

function contractorShowHandler(contractorUuid: string, opts: ContractorShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/contractors/${contractorUuid}`);
}

export function contractorListHandler(opts: ContractorListOpts): CommandHandler {
  return async ({ globals }) => {
    const pg = parsePaginationFlags(opts);
    if (!pg.ok) return validationFailure(pg.message, pg.blocked);
    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const { items, next } = await ctx.client.paginate(`/v1/companies/${ctx.companyUuid}/contractors`, pg.body);
      return { ok: true, data: items, next: pg.body.surfaceNext ? next : undefined };
    });
  };
}
