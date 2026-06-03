import { ApiError, NetworkError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";

export function toResult(err: unknown): CommandResult<never> {
  if (err instanceof ApiError) {
    return {
      ok: false,
      exitCode: err.exitCode,
      error: {
        code: err.status >= 500 ? "api_server_error" : "api_client_error",
        message: err.message,
        ...(err.body !== undefined && err.body !== null ? { details: err.body } : {}),
        ...(err.requestId ? { request_id: err.requestId } : {}),
      },
    };
  }
  if (err instanceof NetworkError) {
    return {
      ok: false,
      exitCode: err.exitCode,
      error: { code: "network_error", message: err.message },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    exitCode: ExitCode.General,
    error: { code: "internal_error", message },
  };
}
