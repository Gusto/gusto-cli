import type { Command } from "commander";
import { PollFailedError, PollTimeoutError } from "../lib/api-client.ts";
import { resolveApiContext } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { type CommandHandler, type CommandResult, runCommand } from "../lib/runner.ts";

export interface GeneralLedgerOpts {
  aggregation?: string;
  integrationType?: string;
}

export interface GeneralLedgerBody {
  aggregation: string;
  integration_type: string;
}

interface ReportStatusBody {
  status?: string;
}

/** Build the POST body for `POST /v1/payrolls/{uuid}/reports/general_ledger`,
 * applying the server defaults (`aggregation: "default"`, `integration_type: ""`). */
export function buildGeneralLedgerBody(opts: GeneralLedgerOpts): GeneralLedgerBody {
  return {
    aggregation: opts.aggregation ?? "default",
    integration_type: opts.integrationType ?? "",
  };
}

/** True once `GET /v1/reports/{uuid}` reports the report finished generating
 * and its download URL is ready. Drives the `poll()` success predicate. */
export function isReportSucceeded(body: ReportStatusBody): boolean {
  return body.status === "Succeeded";
}

/** True once the report request has terminally failed. Drives the `poll()`
 * failure predicate so we stop polling instead of waiting out the timeout. */
export function isReportFailed(body: ReportStatusBody): boolean {
  return body.status === "Failed";
}

interface LedgerShowOpts extends GeneralLedgerOpts {
  /** Commander negation of `--no-wait`: true by default, false when `--no-wait` is passed. */
  wait?: boolean;
  timeout?: string;
  token?: string;
}

export function registerLedgerCommand(parent: Command): void {
  const cmd = parent.command("ledger").description("Inspect ledger data from processed payrolls");

  cmd
    .command("show <payroll_uuid>")
    .description("Generate and fetch the general ledger report for a processed payroll")
    .option("--aggregation <level>", "Report aggregation level (default: default)")
    .option("--integration-type <type>", "Accounting integration format for the report")
    .option("--no-wait", "Return the report request_uuid immediately instead of polling for completion")
    .option("--timeout <seconds>", "Max seconds to poll for completion when waiting (default 120)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .addHelpText(
      "after",
      `
The general ledger report is generated asynchronously: this requests it, then
polls until it is ready (or --timeout elapses) and returns the report URLs.
Use --no-wait to get the request_uuid and poll GET /v1/reports/{request_uuid}
yourself (e.g. via 'gusto api request GET /v1/reports/<uuid>').
`,
    )
    .action((payrollUuid: string, opts: LedgerShowOpts) =>
      runCommand("gusto ledger show", readGlobalFlags(parent.opts()), ledgerShowHandler(payrollUuid, opts)),
    );
}

/** Parse `--timeout <seconds>` into milliseconds; ok:false when it isn't a positive number. */
function resolveTimeoutMs(raw: string | undefined): { ok: true; ms?: number } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false };
  return { ok: true, ms: Math.floor(seconds * 1000) };
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

    const resolved = await resolveApiContext(globals, { tokenOverride: opts.token, requireCompany: false });
    if (!resolved.ok) return resolved.result;
    const { client } = resolved.ctx;

    let requestUuid: string;
    try {
      const created = await client.post<{ request_uuid?: string }>(
        `/v1/payrolls/${payrollUuid}/reports/general_ledger`,
        buildGeneralLedgerBody(opts),
      );
      if (!created.body?.request_uuid) {
        // No request_uuid to poll - surface whatever the API returned rather than guessing.
        return { ok: true, data: created.body };
      }
      requestUuid = created.body.request_uuid;
    } catch (err) {
      return toResult(err);
    }

    const pollPath = `/v1/reports/${requestUuid}`;
    if (opts.wait === false) {
      return { ok: true, data: { request_uuid: requestUuid, status: "pending", poll_path: pollPath } };
    }

    try {
      const report = await client.poll<ReportStatusBody>(pollPath, {
        until: isReportSucceeded,
        isFailure: isReportFailed,
        ...(timeout.ms !== undefined ? { timeoutMs: timeout.ms } : {}),
      });
      return { ok: true, data: report.body };
    } catch (err) {
      if (err instanceof PollFailedError) {
        return {
          ok: false,
          exitCode: ExitCode.ApiServer,
          error: {
            code: "report_failed",
            message: "general ledger report generation failed",
            details: { request_uuid: requestUuid, poll_path: pollPath, report: err.body },
          },
        };
      }
      if (err instanceof PollTimeoutError) {
        return {
          ok: false,
          exitCode: ExitCode.Network,
          error: {
            code: "report_timeout",
            message: `general ledger report ${requestUuid} did not finish before the timeout; poll ${pollPath} to retrieve it`,
            details: { request_uuid: requestUuid, poll_path: pollPath, last_status: err.lastBody },
          },
        };
      }
      return toResult(err);
    }
  };
}
