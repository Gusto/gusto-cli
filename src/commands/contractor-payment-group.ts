import type { Command } from "commander";
import { fetchResource, withCompanyContext } from "../lib/api-context.ts";
import { ALL_OPT, CURSOR_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { isValidIsoDate, isValidUuid } from "../lib/parse.ts";
import { parsePaginationFlags } from "../lib/pagination.ts";
import { type QueryParams, toQueryString } from "../lib/query.ts";
import { type CommandHandler, invalidUuid, runReadCommand, validationFailure } from "../lib/runner.ts";

/** Where a caller goes to get a real identifier when the one they passed can't name a record. */
const CONTRACTOR_PAYMENT_GROUP_LOOKUP = "gusto contractor-payment-group list";

interface ContractorPaymentGroupListOpts {
  startDate?: string;
  endDate?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
  cursor?: string;
  limit?: string;
  all?: boolean;
}

interface ContractorPaymentGroupShowOpts {
  tokenStdin?: boolean;
}

export function registerContractorPaymentGroupCommand(parent: Command): void {
  const cmd = parent.command("contractor-payment-group").description("List and inspect contractor payment groups");

  cmd
    .command("show <contractor_payment_group_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read a contractor payment group record")
    .option(...TOKEN_STDIN_OPT)
    .action((contractorPaymentGroupUuid: string, opts: ContractorPaymentGroupShowOpts) =>
      runReadCommand(
        "gusto contractor-payment-group show",
        readGlobalFlags(parent.opts()),
        contractorPaymentGroupShowHandler(contractorPaymentGroupUuid, opts),
      ),
    );

  cmd
    .command("list")
    .description("List company contractor payment groups")
    .option("--start-date <date>", "Only groups on/after this date (YYYY-MM-DD; defaults to 6 months ago)")
    .option("--end-date <date>", "Only groups up to this date (YYYY-MM-DD; defaults to today)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...CURSOR_OPT)
    .option("--limit <n>", "Maximum contractor payment groups to return across pages")
    .option(...ALL_OPT)
    .action((opts: ContractorPaymentGroupListOpts) =>
      runReadCommand(
        "gusto contractor-payment-group list",
        readGlobalFlags(parent.opts()),
        contractorPaymentGroupListHandler(opts),
      ),
    );
}

export function contractorPaymentGroupShowHandler(
  contractorPaymentGroupUuid: string,
  opts: ContractorPaymentGroupShowOpts,
): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(contractorPaymentGroupUuid)) {
      return invalidUuid("contractor_payment_group_uuid", contractorPaymentGroupUuid, CONTRACTOR_PAYMENT_GROUP_LOOKUP);
    }
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/contractor_payment_groups/${encodeURIComponent(contractorPaymentGroupUuid)}`,
    );
  };
}

export function contractorPaymentGroupListHandler(opts: ContractorPaymentGroupListOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.startDate !== undefined && !isValidIsoDate(opts.startDate)) {
      return validationFailure("invalid arguments", [
        { field: "start-date", reason: "must be a valid date in YYYY-MM-DD format" },
      ]);
    }
    if (opts.endDate !== undefined && !isValidIsoDate(opts.endDate)) {
      return validationFailure("invalid arguments", [
        { field: "end-date", reason: "must be a valid date in YYYY-MM-DD format" },
      ]);
    }
    const pg = parsePaginationFlags(opts);
    if (!pg.ok) return validationFailure(pg.message, pg.blocked);

    const query: QueryParams = { start_date: opts.startDate, end_date: opts.endDate };
    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const { items, next } = await ctx.client.paginate(
        `/v1/companies/${ctx.companyUuid}/contractor_payment_groups${toQueryString(query)}`,
        pg.body,
      );
      return { ok: true, data: items, next: pg.body.surfaceNext ? next : undefined };
    });
  };
}
