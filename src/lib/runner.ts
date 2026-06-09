import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";
import { availableFields, selectFields, unknownFields } from "./field-filter.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { type BlockedOn, type EnvelopeError, type StreamSinks, emit, outputOptionsFrom } from "./output.ts";

export interface CommandContext {
  command: string;
  globals: GlobalFlags;
}

export type CommandResult<T = unknown> =
  | { ok: true; data?: T }
  | {
      ok: false;
      exitCode: ExitCodeValue;
      error: EnvelopeError;
    };

export type CommandHandler<T = unknown> = (ctx: CommandContext) => Promise<CommandResult<T>>;

/** A validator's result: a built request body on success, or a message + blocked_on list on
 * failure. Generic so each command's `validate*` function shares one shape. */
export type ValidationResult<T> = { ok: true; body: T } | { ok: false; message: string; blocked: BlockedOn[] };

export interface RunnerDeps {
  exit: (code: number) => never;
  sinks?: StreamSinks;
}

const defaultDeps: RunnerDeps = {
  exit: (code) => process.exit(code) as never,
};

/** Run a command that may mutate state. A bare `--fields` (discovery) is rejected up front,
 * before the handler runs, because discovery introspects output shape and must not trigger a
 * write just to do so — see runReadCommand for the read-only counterpart. */
export function runCommand<T>(
  command: string,
  globals: GlobalFlags,
  handler: CommandHandler<T>,
  deps: RunnerDeps = defaultDeps,
): Promise<never> {
  return run(command, globals, handler, deps, false);
}

/** Run a read-only command. Identical to runCommand except a bare `--fields` lists the available
 * output fields (gh-style discovery) — safe here because the handler has no side effects. */
export function runReadCommand<T>(
  command: string,
  globals: GlobalFlags,
  handler: CommandHandler<T>,
  deps: RunnerDeps = defaultDeps,
): Promise<never> {
  return run(command, globals, handler, deps, true);
}

async function run<T>(
  command: string,
  globals: GlobalFlags,
  handler: CommandHandler<T>,
  deps: RunnerDeps,
  readOnly: boolean,
): Promise<never> {
  const output = outputOptionsFrom(globals);
  const selection = globals.fields;

  // Discovery (bare `--fields`) is a read-only usage helper. On a mutating command it would
  // otherwise run the handler — performing the write — just to introspect the result's shape,
  // then exit non-zero, which an agent reads as failure and retries (duplicating the record).
  // Reject it before the handler executes; `--fields <list>` is unaffected and still runs.
  if (selection?.mode === "discover" && !readOnly) {
    emit(
      output,
      {
        ok: false,
        error: {
          code: "fields_discovery_unsupported",
          message: `\`--fields\` with no value lists output fields and is only available on read commands; \`${command}\` is not one. Pass an explicit list, e.g. \`--fields uuid,email\`.`,
        },
      },
      deps.sinks,
    );
    return deps.exit(ExitCode.CliUsage);
  }

  let code: ExitCodeValue;
  try {
    const result = await handler({ command, globals });
    if (!result.ok) {
      emit(output, { ok: false, error: result.error }, deps.sinks);
      code = result.exitCode;
    } else if (selection?.mode === "discover") {
      // gh convention: a bare `--fields` is a usage error — list the available top-level fields
      // on stderr, leave stdout empty, and exit non-zero. Only reached on success; an errored
      // command falls through to the error branch and surfaces its own failure instead.
      writeFieldsHint(availableFields(result.data), deps);
      code = ExitCode.General;
    } else if (selection?.mode === "select" && unknownFields(result.data, selection.keys).length > 0) {
      // A requested key that matches nothing in the data is almost always a typo. Mirror gh and
      // the discovery hint: name the unknown field(s), list what's valid on stderr, and exit
      // non-zero — rather than silently emitting an empty projection that reads as a successful
      // empty result. A key present in only *some* array rows stays valid (see unknownFields).
      writeUnknownFieldsError(unknownFields(result.data, selection.keys), availableFields(result.data), deps);
      code = ExitCode.General;
    } else {
      // `--fields <list>` only ever reshapes successful output; without it, data passes through.
      const data = selection?.mode === "select" ? selectFields(result.data, selection.keys) : result.data;
      emit(output, { ok: true, data }, deps.sinks);
      code = ExitCode.Success;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(
      output,
      {
        ok: false,
        error: { code: "internal_error", message },
      },
      deps.sinks,
    );
    code = ExitCode.General;
  }
  return deps.exit(code);
}

/** A validation failure (exit 7) carrying a caller-supplied message and blocked_on list. */
export function validationFailure(message: string, blocked: BlockedOn[]): CommandResult<never> {
  return {
    ok: false,
    exitCode: ExitCode.Validation,
    error: { code: "validation", message, blocked_on: blocked },
  };
}

/** Standard "missing required arguments" validation failure with a blocked_on list. */
export function missingArgs(blocked: BlockedOn[]): CommandResult<never> {
  return validationFailure("missing required arguments", blocked);
}

/** Indented, newline-joined list of field names for a stderr hint, or a placeholder when empty. */
function fieldLines(fields: string[]): string {
  return fields.length > 0 ? fields.map((f) => `  ${f}`).join("\n") : "  (no top-level fields available)";
}

/** Print the gh-style "you must specify fields" hint to stderr, listing what's available. */
function writeFieldsHint(fields: string[], deps: RunnerDeps): void {
  const stderr = deps.sinks?.stderr ?? process.stderr;
  stderr.write(`Specify one or more comma-separated fields for \`--fields\`:\n${fieldLines(fields)}\n`);
}

/** Print the gh-style "unknown field" error to stderr, naming the bad keys and listing valid ones. */
function writeUnknownFieldsError(unknown: string[], available: string[], deps: RunnerDeps): void {
  const stderr = deps.sinks?.stderr ?? process.stderr;
  stderr.write(`Unknown \`--fields\` value(s): ${unknown.join(", ")}\nAvailable fields:\n${fieldLines(available)}\n`);
}

export function notImplementedHandler(commandPath: string): CommandHandler {
  return async () => ({
    ok: false,
    exitCode: ExitCode.General,
    error: {
      code: "not_implemented",
      message: `\`${commandPath}\` is not implemented yet`,
    },
  });
}
