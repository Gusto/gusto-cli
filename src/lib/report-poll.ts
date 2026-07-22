import { type ApiClient, PollFailedError, PollTimeoutError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import { toResult } from "./handle-api-error.ts";
import type { CommandResult } from "./runner.ts";

export interface ReportStatusBody {
  status?: string;
}

/** True once the report retrieval endpoint reports the report finished generating and its
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

export function reportPollPath(requestUuid: string): string {
  return `/v1/reports/${encodeURIComponent(requestUuid)}`;
}

/** Poll the report retrieval endpoint until the report succeeds, fails, or the budget elapses,
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
          details: { request_uuid: requestUuid, poll_path: pollPath, response: err.body },
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
    // A non-terminal error mid-poll (token expiry, a 4xx, or a 5xx that outlasts the retry budget)
    // still leaves a report generating server-side. Preserve the request_uuid + poll_path so the
    // caller can resume with `gusto report get` instead of losing the in-flight report, matching
    // the report_failed/report_timeout exits above.
    const result = toResult(err);
    if (result.ok) return result;
    return {
      ...result,
      error: {
        ...result.error,
        details: {
          request_uuid: requestUuid,
          poll_path: pollPath,
          ...(result.error.details !== undefined ? { response: result.error.details } : {}),
        },
      },
    };
  }
}
