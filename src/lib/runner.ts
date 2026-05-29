import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { type BlockedOn, type StreamSinks, emit, outputOptionsFrom } from "./output.ts";

export interface CommandContext {
  command: string;
  globals: GlobalFlags;
}

export type CommandResult<T = unknown> =
  | { ok: true; data?: T }
  | {
      ok: false;
      exitCode: ExitCodeValue;
      error: { code: string; message: string; blocked_on?: BlockedOn[] };
    };

export type CommandHandler<T = unknown> = (ctx: CommandContext) => Promise<CommandResult<T>>;

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
    if (result.ok) {
      emit(output, { ok: true, data: result.data }, deps.sinks);
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
