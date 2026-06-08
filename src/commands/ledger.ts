import type { Command } from "commander";
import { type ApiClient, PollFailedError, PollTimeoutError } from "../lib/api-client.ts";
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

/** Parse `--timeout <seconds>` into milliseconds; ok:false when it isn't a positive, finite number. */
export function resolveTimeoutMs(raw: string | undefined): { ok: true; ms?: number } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false };
  return { ok: true, ms: Math.floor(seconds * 1000) };
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

  const pollPath = `/v1/reports/${encodeURIComponent(requestUuid)}`;
  if (opts.wait === false) {
    return { ok: true, data: { request_uuid: requestUuid, status: "pending", poll_path: pollPath } };
  }

  try {
    const report = await client.poll<ReportStatusBody>(pollPath, {
      until: isReportSucceeded,
      isFailure: isReportFailed,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
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
        exitCode: ExitCode.Timeout,
        error: {
          code: "report_timeout",
          message: `general ledger report ${requestUuid} did not finish before the timeout; poll ${pollPath} to retrieve it`,
          details: { request_uuid: requestUuid, poll_path: pollPath, last_status: err.lastBody },
        },
      };
    }
    return toResult(err);
  }
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

    return executeLedgerShow(resolved.ctx.client, payrollUuid, {
      aggregation: opts.aggregation,
      integrationType: opts.integrationType,
      wait: opts.wait,
      ...(timeout.ms !== undefined ? { timeoutMs: timeout.ms } : {}),
    });
  };
}
