import type { GlobalFlags } from "./global-flags.ts";
import { isObject } from "./predicates.ts";

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
  /** Subcommands available where a usage error occurred (unknown-command errors), so an agent can
   * retry with a real command instead of dead-ending. */
  valid_commands?: string[];
  /** Nearest valid command to what the caller typed, when close enough to suggest. */
  did_you_mean?: string;
  /** Recovery pointer, e.g. the `gusto api request` escape hatch for reads without a command yet. */
  hint?: string;
}

export type AgentEnvelope<T = unknown> = { ok: true; data?: T; next?: string } | { ok: false; error: EnvelopeError };

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

export function emit<T>(
  opts: OutputOptions,
  payload: AgentEnvelope<T>,
  sinks: StreamSinks = defaultSinks,
  // Optional per-command human renderer, as a thunk closing over the result's data. Used only in
  // human mode; agent (JSON) output is always the raw envelope so the machine contract is
  // unaffected. When absent, objects fall back to pretty JSON via formatHuman. A thunk (rather than
  // `(data) => string`) keeps CommandResult<T> assignable to CommandResult<unknown> — a function
  // parameter would be contravariant and break that for every handler.
  renderHuman?: () => string,
): void {
  if (opts.mode === "agent") {
    sinks.stdout.write(`${JSON.stringify(payload)}\n`);
    if (!payload.ok) writeHumanError(payload.error, sinks.stderr);
    return;
  }
  if (payload.ok) {
    if (payload.data !== undefined) {
      const text = renderHuman ? renderHuman() : formatHuman(payload.data);
      sinks.stdout.write(`${text}\n`);
    }
    if (payload.next !== undefined) {
      sinks.stderr.write(`more results: pass --cursor ${payload.next} (or --all)\n`);
    }
    return;
  }
  writeHumanError(payload.error, sinks.stderr);
}

/** The human-facing message(s) from a Gusto API error body's `errors` array, joined, or undefined
 * when `details` isn't that shape. `error.details` is never printed in human mode otherwise, so this
 * is how the API's own reason for a failure reaches a human. Only the `{ errors: [{ message }] }`
 * shape is surfaced; other detail shapes (report's `response` wrapper, partial-failure structures,
 * raw bodies) are deliberately left out so a human terminal never gets a large JSON dump. */
function apiErrorMessages(details: unknown): string | undefined {
  if (!isObject(details) || !Array.isArray(details.errors)) return undefined;
  const messages = details.errors
    .map((e) => (isObject(e) && typeof e.message === "string" ? e.message.trim() : ""))
    .filter((m) => m.length > 0);
  return messages.length > 0 ? messages.join("; ") : undefined;
}

function writeHumanError(err: EnvelopeError, stderr: NodeJS.WritableStream): void {
  stderr.write(`error: ${err.message}\n`);
  // Surface the API's own message from details (invisible in human mode otherwise), unless the
  // error line already carries it (e.g. a curated message that quotes the API text verbatim).
  const reason = apiErrorMessages(err.details);
  if (reason !== undefined && !err.message.toLowerCase().includes(reason.toLowerCase())) {
    stderr.write(`reason: ${reason}\n`);
  }
  if (err.blocked_on && err.blocked_on.length > 0) {
    stderr.write("blocked on:\n");
    for (const b of err.blocked_on) {
      stderr.write(`  - ${b.field}: ${b.reason}\n`);
    }
  }
  if (err.did_you_mean !== undefined) stderr.write(`did you mean: ${err.did_you_mean}?\n`);
  if (err.valid_commands && err.valid_commands.length > 0) {
    stderr.write(`available commands: ${err.valid_commands.join(", ")}\n`);
  }
  if (err.hint !== undefined) stderr.write(`hint: ${err.hint}\n`);
}

function formatHuman(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  return JSON.stringify(data, null, 2);
}
