import { type ApiClient, PollFailedError, PollTimeoutError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import { toResult } from "./handle-api-error.ts";
import type { CommandResult } from "./runner.ts";

export interface ReportStatusBody {
  status?: string;
}

/** True once `GET /v1/reports/{request_uuid}` reports the report finished generating and its
 * download URL is ready. Drives the `poll()` success predicate. Case-insensitive: the API
 * serializes statuses lowercase (`succeeded`), but we match defensively so a casing change on
 * either side can't silently break polling. */
export function isReportSucceeded(body: ReportStatusBody): boolean {
  return body.status?.toLowerCase() === "succeeded";
}

/** True once the report request has terminally failed. Drives the `poll()` failure predicate so we
 * stop polling instead of waiting out the timeout. */
export function isReportFailed(body: ReportStatusBody): boolean {
  return body.status?.toLowerCase() === "failed";
}

/** The report retrieval path. Report *creation* is scoped (POST to a company or payroll path), but
 * retrieval is always top-level: `GET /v1/reports/{request_uuid}`. Building this by appending the
 * request_uuid to a company-scoped create path hits a route that does not exist (404). */
export function reportPollPath(requestUuid: string): string {
  return `/v1/reports/${encodeURIComponent(requestUuid)}`;
}

/** Poll `GET /v1/reports/{request_uuid}` until the report succeeds, fails, or the budget elapses,
 * and map the outcome to a CommandResult. Shared by every async report flow (general ledger,
 * custom reports) so the poll path and the failed/timeout envelopes can't drift. `label` names the
 * report in user-facing messages. */
export async function pollReport(
  client: Pick<ApiClient, "poll">,
  requestUuid: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<CommandResult> {
  const label = opts.label ?? "report";
  const pollPath = reportPollPath(requestUuid);
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
          message: `${label} generation failed`,
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
          message: `${label} ${requestUuid} did not finish before the timeout; poll ${pollPath} to retrieve it`,
          details: {
            request_uuid: requestUuid,
            poll_path: pollPath,
            attempts: err.attempts,
            // Omit when no GET completed (e.g. budget already spent) rather than emit last_status: undefined.
            ...(err.lastBody !== undefined ? { last_status: err.lastBody } : {}),
          },
        },
      };
    }
    return toResult(err);
  }
}
