import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";
import { availableFields, selectFields } from "./field-filter.ts";
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

export async function runCommand<T>(
  command: string,
  globals: GlobalFlags,
  handler: CommandHandler<T>,
  deps: RunnerDeps = defaultDeps,
): Promise<never> {
  const output = outputOptionsFrom(globals);
  let code: ExitCodeValue;
  try {
    const result = await handler({ command, globals });
    const selection = globals.fields;
    if (result.ok && selection?.mode === "discover") {
      // gh convention: a bare `--fields` is a usage error — list the available top-level fields
      // on stderr, leave stdout empty, and exit non-zero. Only reached on success; an errored
      // command falls through to the error branch and surfaces its own failure instead.
      writeFieldsHint(availableFields(result.data), deps);
      code = ExitCode.General;
    } else if (result.ok) {
      // `--fields <list>` only ever reshapes successful output; without it, data passes through.
      const data = selection?.mode === "select" ? selectFields(result.data, selection.keys) : result.data;
      emit(output, { ok: true, data }, deps.sinks);
      code = ExitCode.Success;
    } else {
      emit(output, { ok: false, error: result.error }, deps.sinks);
      code = result.exitCode;
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

/** Print the gh-style "you must specify fields" hint to stderr, listing what's available. */
function writeFieldsHint(fields: string[], deps: RunnerDeps): void {
  const stderr = deps.sinks?.stderr ?? process.stderr;
  const body = fields.length > 0 ? fields.map((f) => `  ${f}`).join("\n") : "  (no top-level fields available)";
  stderr.write(`Specify one or more comma-separated fields for \`--fields\`:\n${body}\n`);
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
