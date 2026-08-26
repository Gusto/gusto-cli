import type { Command } from "commander";
import type { ApiClient } from "../lib/api-client.ts";
import { fetchCompanyResource, fetchResource, withCompanyContext } from "../lib/api-context.ts";
import { ALL_OPT, CURSOR_OPT, TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { malformedResponse } from "../lib/errors.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import type { BlockedOn } from "../lib/output.ts";
import { detectNext, encodeCursor, parsePaginationFlags, withPageParams } from "../lib/pagination.ts";
import { isValidIsoDate, isValidUuid } from "../lib/parse.ts";
import { isObject } from "../lib/predicates.ts";
import { type QueryParams, toQueryString } from "../lib/query.ts";
import {
  type CommandHandler,
  type CommandResult,
  invalidUuid,
  runReadCommand,
  validationFailure,
} from "../lib/runner.ts";

/** Where a caller goes to get a real identifier when the one they passed can't name a record. */
const CONTRACTOR_PAYMENT_UUID_HINT = "run `gusto contractor-payment list` to get a real contractor_payment_uuid";

interface ContractorPaymentListOpts {
  startDate?: string;
  endDate?: string;
  contractorUuid?: string;
  groupByDate?: boolean;
  companyUuid?: string;
  tokenStdin?: boolean;
  cursor?: string;
  limit?: string;
  all?: boolean;
}

interface ContractorPaymentShowOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
}

interface ContractorPaymentReceiptOpts {
  tokenStdin?: boolean;
}

export function registerContractorPaymentCommand(parent: Command): void {
  const cmd = parent.command("contractor-payment").description("List and inspect contractor payments");

  cmd
    .command("show <contractor_payment_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Read a contractor payment record")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .action((contractorPaymentUuid: string, opts: ContractorPaymentShowOpts) =>
      runReadCommand(
        "gusto contractor-payment show",
        readGlobalFlags(parent.opts()),
        contractorPaymentShowHandler(contractorPaymentUuid, opts),
      ),
    );

  cmd
    .command("receipt <contractor_payment_uuid>")
    .description("Get a contractor payment's payment receipt (available once paid by direct deposit and funded)")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
Not company-scoped: reads /v1/contractor_payments/{contractor_payment_uuid}/receipt directly (no
--company-uuid). Only available once the payment has been made by direct deposit and funded; a
check payment or an unfunded direct deposit returns 404.

Examples:
  $ gusto contractor-payment receipt 1a2b3c4d-0000-1111-2222-333344445555
`,
    )
    .action((contractorPaymentUuid: string, opts: ContractorPaymentReceiptOpts) =>
      runReadCommand(
        "gusto contractor-payment receipt",
        readGlobalFlags(parent.opts()),
        contractorPaymentReceiptHandler(contractorPaymentUuid, opts),
      ),
    );

  cmd
    .command("list")
    .description("List company contractor payments in a date range")
    // Required by the API, but enforced in the handler (not via commander's `.requiredOption`) so an
    // omitted flag returns the documented blocked_on envelope (exit 7) rather than commander's
    // generic cli_usage error (exit 2) - see report.ts's `--columns` for the same rationale.
    .option("--start-date <date>", "Only payments on/after this date (YYYY-MM-DD; required by the API)")
    .option("--end-date <date>", "Only payments up to this date (YYYY-MM-DD; required by the API)")
    .option("--contractor-uuid <uuid>", "Filter to a single contractor's payments")
    .option("--group-by-date", "Group results by check date instead of by contractor")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option(...TOKEN_STDIN_OPT)
    .option(...CURSOR_OPT)
    .option("--limit <n>", "Maximum contractor_payments entries to return across pages")
    .option(...ALL_OPT)
    .addHelpText(
      "after",
      `
Mirrors GET /v1/companies/{company}/contractor_payments; the response bundles a "total" summary
(wages + reimbursements) alongside the paginated contractor_payments array.
`,
    )
    .action((opts: ContractorPaymentListOpts) =>
      runReadCommand(
        "gusto contractor-payment list",
        readGlobalFlags(parent.opts()),
        contractorPaymentListHandler(opts),
      ),
    );
}

export function contractorPaymentShowHandler(
  contractorPaymentUuid: string,
  opts: ContractorPaymentShowOpts,
): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(contractorPaymentUuid)) {
      return invalidUuid("contractor_payment_uuid", contractorPaymentUuid, CONTRACTOR_PAYMENT_UUID_HINT);
    }
    return fetchCompanyResource(
      globals,
      { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/contractor_payments/${encodeURIComponent(contractorPaymentUuid)}`,
    );
  };
}

/** GET the contractor payment receipt. Unlike `contractor-payment show`, the endpoint is a bare
 * resource path (`/v1/contractor_payments/{uuid}/receipt`, not company-scoped), so this goes
 * through `fetchResource` rather than `fetchCompanyResource`. */
export function contractorPaymentReceiptHandler(
  contractorPaymentUuid: string,
  opts: ContractorPaymentReceiptOpts,
): CommandHandler {
  return async ({ globals }) => {
    if (!isValidUuid(contractorPaymentUuid)) {
      return invalidUuid("contractor_payment_uuid", contractorPaymentUuid, CONTRACTOR_PAYMENT_UUID_HINT);
    }
    return fetchResource(
      globals,
      { tokenStdin: opts.tokenStdin },
      () => `/v1/contractor_payments/${encodeURIComponent(contractorPaymentUuid)}/receipt`,
    );
  };
}

/** Walk `GET .../contractor_payments`, whose body wraps the paginated array in `contractor_payments`
 * alongside an aggregate `total` (wages + reimbursements for the whole date range, not per page) -
 * unlike the bare-array shape `ApiClient.paginate` assumes, so this can't reuse it directly. Mirrors
 * `ApiClient.paginate`'s page-walking (same `detectNext`/cursor semantics) but keeps the last-seen
 * `total` and nests the accumulated items back under `contractor_payments` for output parity with
 * `gusto api request GET`. */
async function paginateContractorPayments(
  client: ApiClient,
  path: string,
  pg: { startPage: number; per: number; maxItems?: number; surfaceNext: boolean },
): Promise<CommandResult> {
  const { per, maxItems } = pg;
  let page = pg.startPage;
  const items: unknown[] = [];
  let total: unknown;
  let nextPage: number | undefined;
  for (;;) {
    const res = await client.get<unknown>(withPageParams(path, page, per));
    if (!isObject(res.body) || !Array.isArray(res.body.contractor_payments)) {
      return malformedResponse(`${path} returned an unexpected body shape`);
    }
    total = res.body.total;
    items.push(...res.body.contractor_payments);
    nextPage = detectNext(res.headers, page, res.body.contractor_payments.length, per);
    if (nextPage === undefined) break;
    if (maxItems !== undefined && items.length >= maxItems) break;
    page = nextPage;
  }
  const truncated = maxItems !== undefined && items.length > maxItems;
  if (truncated) items.length = maxItems;
  const next = nextPage !== undefined && !truncated ? encodeCursor(nextPage, per) : undefined;
  return { ok: true, data: { total, contractor_payments: items }, next: pg.surfaceNext ? next : undefined };
}

export function contractorPaymentListHandler(opts: ContractorPaymentListOpts): CommandHandler {
  return async ({ globals }) => {
    const blocked: BlockedOn[] = [];
    if (!opts.startDate) blocked.push({ field: "start-date", reason: "required by the API" });
    else if (!isValidIsoDate(opts.startDate)) {
      blocked.push({ field: "start-date", reason: "must be a valid date in YYYY-MM-DD format" });
    }
    if (!opts.endDate) blocked.push({ field: "end-date", reason: "required by the API" });
    else if (!isValidIsoDate(opts.endDate)) {
      blocked.push({ field: "end-date", reason: "must be a valid date in YYYY-MM-DD format" });
    }
    if (opts.contractorUuid !== undefined && !isValidUuid(opts.contractorUuid)) {
      blocked.push({ field: "contractor-uuid", reason: "must be a valid UUID" });
    }
    if (blocked.length > 0) return validationFailure("invalid arguments", blocked);

    const pg = parsePaginationFlags(opts);
    if (!pg.ok) return validationFailure(pg.message, pg.blocked);

    const query: QueryParams = {
      start_date: opts.startDate,
      end_date: opts.endDate,
      contractor_uuid: opts.contractorUuid,
      group_by_date: opts.groupByDate ? "true" : undefined,
    };
    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, (ctx) =>
      paginateContractorPayments(
        ctx.client,
        `/v1/companies/${ctx.companyUuid}/contractor_payments${toQueryString(query)}`,
        pg.body,
      ),
    );
  };
}
