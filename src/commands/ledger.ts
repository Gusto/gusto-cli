import type { Command } from "commander";
import type { ApiClient } from "../lib/api-client.ts";
import { resolveApiContext } from "../lib/api-context.ts";
import { TOKEN_STDIN_OPT } from "../lib/cli-options.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { resolveTimeoutMs } from "../lib/parse.ts";
import { pollReport, reportPollPath } from "../lib/report-poll.ts";
import { type CommandHandler, type CommandResult, runCommand } from "../lib/runner.ts";

// Report status predicates live in report-poll.ts (shared with `gusto report`); re-exported here so
// existing importers of this module keep resolving them.
export { isReportFailed, isReportSucceeded } from "../lib/report-poll.ts";

export interface GeneralLedgerOpts {
  aggregation?: string;
  integrationType?: string;
}

export interface GeneralLedgerBody {
  aggregation: string;
  integration_type: string;
}

/** Build the POST body for the general ledger report create request,
 * applying the server defaults (`aggregation: "default"`, `integration_type: ""`). */
export function buildGeneralLedgerBody(opts: GeneralLedgerOpts): GeneralLedgerBody {
  return {
    aggregation: opts.aggregation ?? "default",
    integration_type: opts.integrationType ?? "",
  };
}

interface LedgerShowOpts extends GeneralLedgerOpts {
  /** Commander negation of `--no-wait`: true by default, false when `--no-wait` is passed. */
  wait?: boolean;
  timeout?: string;
  tokenStdin?: boolean;
}

export function registerLedgerCommand(parent: Command): void {
  const cmd = parent.command("ledger").description("Inspect ledger data from processed payrolls");

  cmd
    .command("show <payroll_uuid>")
    // Agents reach for `get` first and hit "unknown command" and stop - alias it to show.
    .alias("get")
    .description("Generate and fetch the general ledger report for a processed payroll")
    .option("--aggregation <level>", "Report aggregation level (default: default)")
    .option("--integration-type <type>", "Accounting integration format for the report")
    .option("--no-wait", "Return the report request_uuid immediately instead of polling for completion")
    .option("--timeout <seconds>", "Max seconds to poll for completion when waiting (default 120)")
    .option(...TOKEN_STDIN_OPT)
    .addHelpText(
      "after",
      `
The general ledger report is generated asynchronously: this requests it, then
polls until it is ready (or --timeout elapses) and returns the report URLs.
Use --no-wait to get the request_uuid back immediately and fetch the result
later with 'gusto report get <uuid>'.
`,
    )
    .action((payrollUuid: string, opts: LedgerShowOpts) =>
      runCommand("gusto ledger show", readGlobalFlags(parent.opts()), ledgerShowHandler(payrollUuid, opts)),
    );
}

export interface ExecuteLedgerShowOpts extends GeneralLedgerOpts {
  /** false => return the request_uuid immediately instead of polling. */
  wait?: boolean;
  /** Poll budget in ms; omitted => ApiClient.poll default. */
  timeoutMs?: number;
}

/** Request the general ledger report for `payrollUuid`, then either return the
 * poll handle (`wait === false`) or poll until it completes. Takes the client
 * directly so the POST-then-poll flow is unit-testable with a mocked fetch. */
export async function executeLedgerShow(
  client: Pick<ApiClient, "post" | "poll">,
  payrollUuid: string,
  opts: ExecuteLedgerShowOpts,
): Promise<CommandResult> {
  let body: { request_uuid?: string } | null;
  try {
    const created = await client.post<{ request_uuid?: string } | null>(
      `/v1/payrolls/${encodeURIComponent(payrollUuid)}/reports/general_ledger`,
      buildGeneralLedgerBody(opts),
    );
    body = created.body;
  } catch (err) {
    return toResult(err);
  }

  // Guard against a null/empty/request_uuid-less body: we asked to generate a
  // report but got nothing pollable back, so this is an error, not a success.
  const requestUuid = body?.request_uuid;
  if (!requestUuid) {
    return {
      ok: false,
      exitCode: ExitCode.ApiServer,
      error: {
        code: "unexpected_response",
        message: "general ledger report request did not return a request_uuid to poll",
        details: body ?? null,
      },
    };
  }

  if (opts.wait === false) {
    return {
      ok: true,
      data: { request_uuid: requestUuid, status: "pending", poll_path: reportPollPath(requestUuid) },
    };
  }
  return pollReport(client, requestUuid, {
    label: "general ledger report",
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

function ledgerShowHandler(payrollUuid: string, opts: LedgerShowOpts): CommandHandler {
  return async ({ globals }): Promise<CommandResult> => {
    const timeout = resolveTimeoutMs(opts.timeout);
    if (!timeout.ok) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: {
          code: "validation",
          message: "invalid arguments",
          blocked_on: [{ field: "timeout", reason: "must be a positive number of seconds" }],
        },
      };
    }

    const resolved = await resolveApiContext(globals, { tokenStdin: opts.tokenStdin, requireCompany: false });
    if (!resolved.ok) return resolved.result;

    return executeLedgerShow(resolved.ctx.client, payrollUuid, {
      aggregation: opts.aggregation,
      integrationType: opts.integrationType,
      wait: opts.wait,
      ...(timeout.ms !== undefined ? { timeoutMs: timeout.ms } : {}),
    });
  };
}
