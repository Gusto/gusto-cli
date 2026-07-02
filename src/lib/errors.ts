import { ExitCode } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";

/** Best-effort message string from an unknown thrown value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function malformedResponse<T = never>(message: string): CommandResult<T> {
  return { ok: false, exitCode: ExitCode.ApiClient, error: { code: "malformed_response", message } };
}
