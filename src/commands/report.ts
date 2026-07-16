import { type Command, Option } from "commander";
import type { ApiClient } from "../lib/api-client.ts";
import { resolveApiContext } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT, withContextOptions } from "../lib/cli-options.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { isValidIsoDate, resolveTimeoutMs } from "../lib/parse.ts";
import { pollReport, reportPollPath } from "../lib/report-poll.ts";
import type { BlockedOn } from "../lib/output.ts";
import { type CommandHandler, type CommandResult, runCommand, validationFailure } from "../lib/runner.ts";

/** Groupings the Reports API accepts for `--group-by`. */
const GROUP_BY_CHOICES = ["payroll", "employee", "work_address", "work_address_state"] as const;
/** `date_filter_type` values the Reports API accepts. */
const DATE_FILTER_CHOICES = ["period_end_date", "period_start_date", "check_date"] as const;
/** Output formats the Reports API accepts; the CLI defaults to json for agent consumption. */
const FILE_TYPE_CHOICES = ["json", "csv", "pdf"] as const;

export interface ReportRunOpts {
  /** Report columns; required and non-empty (the API rejects an empty column list). */
  columns: string[];
  groupBy?: string[];
  from?: string;
  to?: string;
  dateFilterType?: string;
  withTotals?: boolean;
  fileType?: string;
  name?: string;
}

/** The `POST /v1/companies/{company_uuid}/reports` request body. Field names map 1:1 to the
 * Reports API; the CLI does no bespoke report assembly. */
export interface ReportBody {
  columns: string[];
  file_type: string;
  groupings?: string[];
  start_date?: string;
  end_date?: string;
  date_filter_type?: string;
  with_totals?: boolean;
  custom_name?: string;
}

/** Build the create-report request body from CLI options, applying the CLI default `file_type=json`
 * and omitting every optional field the caller didn't set. */
export function buildReportBody(opts: ReportRunOpts): ReportBody {
  const body: ReportBody = { columns: opts.columns, file_type: opts.fileType ?? "json" };
  if (opts.groupBy && opts.groupBy.length > 0) body.groupings = opts.groupBy;
  if (opts.from !== undefined) body.start_date = opts.from;
  if (opts.to !== undefined) body.end_date = opts.to;
  if (opts.dateFilterType !== undefined) body.date_filter_type = opts.dateFilterType;
  if (opts.withTotals) body.with_totals = true;
  if (opts.name !== undefined) body.custom_name = opts.name;
  return body;
}

export interface ExecuteReportRunOpts extends ReportRunOpts {
  /** false => return the request_uuid immediately instead of polling. */
  wait?: boolean;
  /** Poll budget in ms; omitted => ApiClient.poll default. */
  timeoutMs?: number;
}

/** Create the report (company-scoped POST) then either return the poll handle (`wait === false`)
 * or poll the top-level `/v1/reports/{request_uuid}` until it completes. Takes the client directly
 * so the create-then-poll flow is unit-testable with a mocked fetch. */
export async function executeReportRun(
  client: Pick<ApiClient, "post" | "poll">,
  companyUuid: string,
  opts: ExecuteReportRunOpts,
): Promise<CommandResult> {
  let body: { request_uuid?: string } | null;
  try {
    const created = await client.post<{ request_uuid?: string } | null>(
      `/v1/companies/${encodeURIComponent(companyUuid)}/reports`,
      buildReportBody(opts),
    );
    body = created.body;
  } catch (err) {
    return toResult(err);
  }

  // Guard against a null/empty/request_uuid-less body: we asked to generate a report but got
  // nothing pollable back, so this is an error, not a success.
  const requestUuid = body?.request_uuid;
  if (!requestUuid) {
    return {
      ok: false,
      exitCode: ExitCode.ApiServer,
      error: {
        code: "unexpected_response",
        message: "report request did not return a request_uuid to poll",
        details: body ?? null,
      },
    };
  }

  if (opts.wait === false) {
    return { ok: true, data: { request_uuid: requestUuid, status: "pending", poll_path: reportPollPath(requestUuid) } };
  }
  return pollReport(client, requestUuid, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
}

/** Fetch a previously requested report by its request_uuid. With `wait === false` this does a
 * single GET and returns the current status; otherwise it polls until the report completes. Always
 * hits the top-level retrieval path. */
export async function executeReportGet(
  client: Pick<ApiClient, "get" | "poll">,
  requestUuid: string,
  opts: { wait?: boolean; timeoutMs?: number },
): Promise<CommandResult> {
  if (opts.wait === false) {
    try {
      const response = await client.get(reportPollPath(requestUuid));
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  }
  return pollReport(client, requestUuid, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
}

/** Split a comma-separated flag value into trimmed, non-empty items. */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface ReportRunCliOpts {
  columns: string;
  groupBy?: string;
  from?: string;
  to?: string;
  dateFilterType?: string;
  withTotals?: boolean;
  fileType?: string;
  name?: string;
  wait?: boolean;
  timeout?: string;
  companyUuid?: string;
  tokenStdin?: boolean;
}

function reportRunHandler(opts: ReportRunCliOpts): CommandHandler {
  return async ({ globals }): Promise<CommandResult> => {
    const timeout = resolveTimeoutMs(opts.timeout);
    const blocked: BlockedOn[] = [];
    if (!timeout.ok) blocked.push({ field: "timeout", reason: "must be a positive number of seconds" });
    if (opts.from !== undefined && !isValidIsoDate(opts.from)) {
      blocked.push({ field: "from", reason: "must be a date in YYYY-MM-DD form" });
    }
    if (opts.to !== undefined && !isValidIsoDate(opts.to)) {
      blocked.push({ field: "to", reason: "must be a date in YYYY-MM-DD form" });
    }
    const columns = splitList(opts.columns);
    if (columns.length === 0) blocked.push({ field: "columns", reason: "must list at least one column" });
    if (blocked.length > 0) return validationFailure("invalid arguments", blocked);

    const resolved = await resolveApiContext(globals, {
      tokenStdin: opts.tokenStdin,
      companyOverride: opts.companyUuid,
    });
    if (!resolved.ok) return resolved.result;

    return executeReportRun(resolved.ctx.client, resolved.ctx.companyUuid, {
      columns,
      groupBy: opts.groupBy ? splitList(opts.groupBy) : undefined,
      from: opts.from,
      to: opts.to,
      dateFilterType: opts.dateFilterType,
      withTotals: opts.withTotals,
      fileType: opts.fileType,
      name: opts.name,
      wait: opts.wait,
      ...(timeout.ok && timeout.ms !== undefined ? { timeoutMs: timeout.ms } : {}),
    });
  };
}

function reportGetHandler(
  requestUuid: string,
  opts: { wait?: boolean; timeout?: string; tokenStdin?: boolean },
): CommandHandler {
  return async ({ globals }): Promise<CommandResult> => {
    const timeout = resolveTimeoutMs(opts.timeout);
    if (!timeout.ok) {
      return validationFailure("invalid arguments", [
        { field: "timeout", reason: "must be a positive number of seconds" },
      ]);
    }
    const resolved = await resolveApiContext(globals, { tokenStdin: opts.tokenStdin, requireCompany: false });
    if (!resolved.ok) return resolved.result;

    return executeReportGet(resolved.ctx.client, requestUuid, {
      wait: opts.wait,
      ...(timeout.ms !== undefined ? { timeoutMs: timeout.ms } : {}),
    });
  };
}

export function registerReportCommand(parent: Command): void {
  const cmd = parent.command("report").description("Generate custom reports from the Reports API");

  const run = cmd
    .command("run")
    .description("Generate a custom report and poll for the result")
    .requiredOption("--columns <list>", "Comma-separated report columns (see the Reports API column vocabulary)")
    .option("--group-by <list>", `Comma-separated groupings (${GROUP_BY_CHOICES.join(", ")})`)
    .option("--from <date>", "Range start date (YYYY-MM-DD)")
    .option("--to <date>", "Range end date (YYYY-MM-DD)")
    .addOption(
      new Option("--date-filter-type <type>", "Which date the range filters on").choices([...DATE_FILTER_CHOICES]),
    )
    .addOption(new Option("--file-type <type>", "Report output format").choices([...FILE_TYPE_CHOICES]).default("json"))
    .option("--with-totals", "Include subtotals in the report")
    .option("--name <name>", "Report title (custom_name)")
    .option("--no-wait", "Return the request_uuid immediately instead of polling for completion")
    .option("--timeout <seconds>", "Max seconds to poll for completion when waiting (default 120)");
  withContextOptions(run).addHelpText(
    "after",
    `
The report is generated asynchronously: this requests it, then polls until it is
ready (or --timeout elapses) and returns the report URLs. Use --no-wait to get
the request_uuid and poll GET /v1/reports/{request_uuid} yourself (e.g. via
'gusto report get <uuid>').
`,
  );
  run.action((opts: ReportRunCliOpts) =>
    runCommand("gusto report run", readGlobalFlags(parent.opts()), reportRunHandler(opts)),
  );

  cmd
    .command("get <request_uuid>")
    .description("Fetch a previously requested report by its request_uuid")
    .option("--no-wait", "Return the current status without polling")
    .option("--timeout <seconds>", "Max seconds to poll for completion when waiting (default 120)")
    .option(...TOKEN_STDIN_OPT)
    .action((requestUuid: string, opts: { wait?: boolean; timeout?: string; tokenStdin?: boolean }) =>
      runCommand("gusto report get", readGlobalFlags(parent.opts()), reportGetHandler(requestUuid, opts)),
    );
}
