import type { GlobalFlags } from "./global-flags.ts";

export type OutputMode = "agent" | "human";

export interface OutputOptions {
  mode: OutputMode;
  color: boolean;
  verbose: boolean;
}

export interface BlockedOn {
  field: string;
  reason: string;
}

export interface EnvelopeError {
  code: string;
  message: string;
  blocked_on?: BlockedOn[];
  /** Raw API response body when the error came from a Gusto API call.
   * Agents can read this to understand what specifically failed (e.g. field-level validation errors). */
  details?: unknown;
  /** Gusto API request_id from the X-Request-Id header, when present. Useful for support tickets. */
  request_id?: string;
}

export type AgentEnvelope<T = unknown> = { ok: true; data?: T } | { ok: false; error: EnvelopeError };

export interface StreamSinks {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export const defaultSinks: StreamSinks = {
  stdout: process.stdout,
  stderr: process.stderr,
};

export function resolveOutputMode(flags: GlobalFlags, stdoutIsTty = process.stdout.isTTY === true): OutputMode {
  if (flags.json || flags.agent) return "agent";
  if (flags.human) return "human";
  return stdoutIsTty ? "human" : "agent";
}

export function resolveColor(
  mode: OutputMode,
  noColor: string | undefined = process.env.NO_COLOR,
  stdoutIsTty = process.stdout.isTTY === true,
): boolean {
  if (mode === "agent") return false;
  if (noColor !== undefined && noColor !== "") return false;
  return stdoutIsTty;
}

export function outputOptionsFrom(flags: GlobalFlags): OutputOptions {
  const mode = resolveOutputMode(flags);
  return {
    mode,
    color: resolveColor(mode),
    verbose: flags.verbose,
  };
}

export function emit<T>(opts: OutputOptions, payload: AgentEnvelope<T>, sinks: StreamSinks = defaultSinks): void {
  if (opts.mode === "agent") {
    sinks.stdout.write(`${JSON.stringify(payload)}\n`);
    if (!payload.ok) writeHumanError(payload.error, sinks.stderr);
    return;
  }
  if (payload.ok) {
    if (payload.data !== undefined) {
      sinks.stdout.write(`${formatHuman(payload.data)}\n`);
    }
    return;
  }
  writeHumanError(payload.error, sinks.stderr);
}

function writeHumanError(err: EnvelopeError, stderr: NodeJS.WritableStream): void {
  stderr.write(`error: ${err.message}\n`);
  if (err.blocked_on && err.blocked_on.length > 0) {
    stderr.write("blocked on:\n");
    for (const b of err.blocked_on) {
      stderr.write(`  - ${b.field}: ${b.reason}\n`);
    }
  }
}

function formatHuman(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  return JSON.stringify(data, null, 2);
}
