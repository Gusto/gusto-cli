import { describe, expect, test } from "bun:test";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { type CommandHandler, missingArgs, notImplementedHandler, runCommand, validationFailure } from "./runner.ts";
import { captureSinks } from "./test-support.ts";

const flags: GlobalFlags = { agent: true, human: false, json: false, verbose: false };

async function runWithExitCapture<T>(
  command: string,
  handler: CommandHandler<T>,
  globals: GlobalFlags = flags,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { sinks, stdout, stderr } = captureSinks();
  const calls: number[] = [];
  const exit = ((code: number) => {
    calls.push(code);
    throw new Error(`__exit:${code}`);
  }) as (code: number) => never;
  try {
    await runCommand(command, globals, handler, { exit, sinks });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("__exit:")) throw err;
  }
  return { exitCode: calls[calls.length - 1] ?? -1, stdout: stdout.buffer, stderr: stderr.buffer };
}

describe("runCommand", () => {
  test("exits 0 on ok=true and emits the data envelope", async () => {
    const result = await runWithExitCapture("test", async () => ({ ok: true, data: { hello: "world" } }));
    expect(result.exitCode).toBe(ExitCode.Success);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope).toEqual({ ok: true, data: { hello: "world" } });
  });

  test("exits with the handler's exit code and emits an error envelope", async () => {
    const result = await runWithExitCapture("test", async () => ({
      ok: false,
      exitCode: ExitCode.Validation,
      error: { code: "bad_input", message: "nope" },
    }));
    expect(result.exitCode).toBe(ExitCode.Validation);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope).toEqual({ ok: false, error: { code: "bad_input", message: "nope" } });
  });

  test("converts thrown errors into an internal_error envelope and exits 1", async () => {
    const result = await runWithExitCapture("test", async () => {
      throw new Error("boom");
    });
    expect(result.exitCode).toBe(ExitCode.General);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("internal_error");
    expect(envelope.error.message).toBe("boom");
  });

  test("handles non-Error throws gracefully", async () => {
    const result = await runWithExitCapture("test", async () => {
      throw "literal string";
    });
    expect(result.exitCode).toBe(ExitCode.General);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.message).toBe("literal string");
  });

  test("filters success data down to the requested --fields", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({ ok: true, data: { uuid: "u1", email: "a@b.com", extra: "drop me" } }),
      { ...flags, fields: ["uuid", "email"] },
    );
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, data: { uuid: "u1", email: "a@b.com" } });
  });

  test("never filters error envelopes even when --fields is set", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "bad_input", message: "nope" },
      }),
      { ...flags, fields: ["code"] },
    );
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: false, error: { code: "bad_input", message: "nope" } });
  });

  test("passes the command name + globals into the handler context", async () => {
    const captured: { command?: string; globals?: GlobalFlags } = {};
    await runWithExitCapture("gusto company provision", async (ctx) => {
      captured.command = ctx.command;
      captured.globals = ctx.globals;
      return { ok: true };
    });
    expect(captured.command).toBe("gusto company provision");
    expect(captured.globals?.agent).toBe(true);
  });
});

describe("validationFailure", () => {
  test("returns a validation envelope (exit 7) with the message and blocked_on passed through", () => {
    const blocked = [{ field: "start", reason: "required" }];
    const result = validationFailure("missing or invalid arguments", blocked);
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.Validation,
      error: { code: "validation", message: "missing or invalid arguments", blocked_on: blocked },
    });
  });
});

describe("missingArgs", () => {
  test("delegates to validationFailure with the standard message", () => {
    const blocked = [{ field: "email", reason: "required" }];
    const result = missingArgs(blocked);
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.Validation,
      error: { code: "validation", message: "missing required arguments", blocked_on: blocked },
    });
  });
});

describe("notImplementedHandler", () => {
  test("returns a CommandResult with not_implemented and exit code 1", async () => {
    const handler = notImplementedHandler("gusto company provision");
    const result = await handler({ command: "test", globals: flags });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(ExitCode.General);
    expect(result.error.code).toBe("not_implemented");
    expect(result.error.message).toContain("gusto company provision");
  });
});
