import type { Command } from "commander";
import { fetchResource, resolveApiContext, withCompanyContext } from "../lib/api-context.ts";
import { ALL_OPT, CURSOR_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { isValidUuid } from "../lib/parse.ts";
import { parsePaginationFlags } from "../lib/pagination.ts";
import { toQueryString } from "../lib/query.ts";
import { type CommandHandler, invalidUuid, runReadCommand, validationFailure } from "../lib/runner.ts";

/** Where a caller goes to get a real identifier when the one they passed can't name a record. */
const CONTRACTOR_LOOKUP = "gusto contractor list";

// The sort fields GET /v1/contractors/{uuid}/payments accepts, each optionally suffixed with
// ":asc"/":desc". The API 422s on anything else; validating here turns a typo into a fast
// blocked_on instead of a round trip.
const PAYMENT_SORT_FIELDS = ["check_date", "created_at"] as const;
const SORT_DIRECTIONS = ["asc", "desc"] as const;

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

interface ContractorPaymentsOpts {
  tokenStdin?: boolean;
  sortBy?: string;
  cursor?: string;
  limit?: string;
  all?: boolean;
}

/** Validate `--sort-by`'s `field` or `field:direction` shape against the API's accepted values. */
function validateSortBy(sortBy: string | undefined): { field: string; reason: string } | null {
  if (sortBy === undefined) return null;
  const [field, direction, ...rest] = sortBy.split(":");
  if (rest.length > 0 || !PAYMENT_SORT_FIELDS.includes(field as (typeof PAYMENT_SORT_FIELDS)[number])) {
    return {
      field: "sort-by",
      reason: `must be one of ${PAYMENT_SORT_FIELDS.join(", ")}, optionally suffixed :asc/:desc`,
    };
  }
  if (direction !== undefined && !SORT_DIRECTIONS.includes(direction as (typeof SORT_DIRECTIONS)[number])) {
    return { field: "sort-by", reason: `direction must be one of ${SORT_DIRECTIONS.join(", ")}` };
  }
  return null;
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

  cmd
    .command("payments <contractor_uuid>")
    .description("Read a contractor's payments")
    .option("--sort-by <field>", `Sort by ${PAYMENT_SORT_FIELDS.join("|")}, optionally suffixed :asc/:desc`)
    .option(...TOKEN_STDIN_OPT)
    .option(...CURSOR_OPT)
    .option("--limit <n>", "Maximum payments to return across pages")
    .option(...ALL_OPT)
    .action((contractorUuid: string, opts: ContractorPaymentsOpts) =>
      runReadCommand(
        "gusto contractor payments",
        readGlobalFlags(parent.opts()),
        contractorPaymentsHandler(contractorUuid, opts),
      ),
    );
}

function contractorShowHandler(contractorUuid: string, opts: ContractorShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchResource(globals, { tokenStdin: opts.tokenStdin }, () => `/v1/contractors/${contractorUuid}`);
}

export function contractorPaymentsHandler(contractorUuid: string, opts: ContractorPaymentsOpts): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(contractorUuid)) return invalidUuid("contractor_uuid", contractorUuid, CONTRACTOR_LOOKUP);
    const sortByError = validateSortBy(opts.sortBy);
    if (sortByError) return validationFailure("invalid arguments", [sortByError]);
    const pg = parsePaginationFlags(opts);
    if (!pg.ok) return validationFailure(pg.message, pg.blocked);

    const resolved = await resolveApiContext(globals, { tokenStdin: opts.tokenStdin, requireCompany: false });
    if (!resolved.ok) return resolved.result;

    const path = `/v1/contractors/${encodeURIComponent(contractorUuid)}/payments${toQueryString({ sort_by: opts.sortBy })}`;
    try {
      const { items, next } = await resolved.ctx.client.paginate(path, pg.body);
      return { ok: true, data: items, next: pg.body.surfaceNext ? next : undefined };
    } catch (err) {
      return toResult(err);
    }
  };
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
