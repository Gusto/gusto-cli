import { describe, expect, test } from "bun:test";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import {
  type CommandHandler,
  missingArgs,
  notImplementedHandler,
  runCommand,
  runReadCommand,
  validationFailure,
} from "./runner.ts";
import { TEST_CONTEXT as ctx, captureSinks } from "./test-support.ts";

const flags: GlobalFlags = { agent: true, human: false, json: false, verbose: false };

type Runner = typeof runCommand;

async function runWithExitCapture<T>(
  command: string,
  handler: CommandHandler<T>,
  globals: GlobalFlags = flags,
  runner: Runner = runCommand,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { sinks, stdout, stderr } = captureSinks();
  const calls: number[] = [];
  const exit = ((code: number) => {
    calls.push(code);
    throw new Error(`__exit:${code}`);
  }) as (code: number) => never;
  try {
    await runner(command, globals, handler, { exit, sinks });
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
      { ...flags, fields: { mode: "select", keys: ["uuid", "email"] } },
    );
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, data: { uuid: "u1", email: "a@b.com" } });
  });

  test("filters each row when success data is an array (the `employee list` shape)", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({
        ok: true,
        data: [
          { uuid: "u1", email: "a@b.com", name: "Jane" },
          { uuid: "u2", email: "c@d.com", name: "John" },
        ],
      }),
      { ...flags, fields: { mode: "select", keys: ["uuid", "email"] } },
    );
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      ok: true,
      data: [
        { uuid: "u1", email: "a@b.com" },
        { uuid: "u2", email: "c@d.com" },
      ],
    });
  });

  test("emits a structured unknown_fields envelope when a --fields key matches nothing (typo)", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({ ok: true, data: { uuid: "u1", email: "a@b.com" } }),
      { ...flags, fields: { mode: "select", keys: ["uuid", "scpoe"] } },
    );
    expect(result.exitCode).not.toBe(ExitCode.Success);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("unknown_fields");
    expect(envelope.error.details.unknown).toEqual(["scpoe"]);
    expect(envelope.error.details.available).toEqual(["uuid", "email"]);
  });

  test("filters an empty-array result to [] instead of flagging the fields as unknown", async () => {
    const result = await runWithExitCapture("test", async () => ({ ok: true, data: [] }), {
      ...flags,
      fields: { mode: "select", keys: ["uuid"] },
    });
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, data: [] });
  });

  test("does not error when a requested field is present in only some array rows", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({
        ok: true,
        data: [{ uuid: "u1", email: "a@b.com" }, { uuid: "u2" }],
      }),
      { ...flags, fields: { mode: "select", keys: ["uuid", "email"] } },
    );
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      ok: true,
      data: [{ uuid: "u1", email: "a@b.com" }, { uuid: "u2" }],
    });
  });

  test("never filters error envelopes even when --fields is set", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "bad_input", message: "nope" },
      }),
      { ...flags, fields: { mode: "select", keys: ["code"] } },
    );
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: false, error: { code: "bad_input", message: "nope" } });
  });

  test("--fields with no value lists available fields on stderr and exits non-zero (gh convention)", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({ ok: true, data: { uuid: "u1", email: "a@b.com" } }),
      { ...flags, fields: { mode: "discover" } },
      runReadCommand,
    );
    expect(result.exitCode).toBe(ExitCode.General);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--fields");
    expect(result.stderr).toContain("uuid");
    expect(result.stderr).toContain("email");
  });

  test("--fields discovery falls back when there are no top-level fields (handler returns no data)", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({ ok: true }),
      { ...flags, fields: { mode: "discover" } },
      runReadCommand,
    );
    expect(result.exitCode).toBe(ExitCode.General);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--fields");
    expect(result.stderr).toContain("(no top-level fields available)");
  });

  test("discovery does not run on error envelopes", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "bad_input", message: "nope" },
      }),
      { ...flags, fields: { mode: "discover" } },
      runReadCommand,
    );
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: false, error: { code: "bad_input", message: "nope" } });
  });

  test("rejects bare --fields discovery on a mutating command WITHOUT running the handler", async () => {
    let handlerRan = false;
    const result = await runWithExitCapture(
      "gusto employee add",
      async () => {
        handlerRan = true;
        return { ok: true, data: { uuid: "created" } };
      },
      { ...flags, fields: { mode: "discover" } },
      // default runner = runCommand (mutating / non-discoverable)
    );
    expect(handlerRan).toBe(false);
    expect(result.exitCode).not.toBe(ExitCode.Success);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("fields_discovery_unsupported");
  });

  test("still runs select-mode --fields on a mutating command (only bare discovery is gated)", async () => {
    let handlerRan = false;
    const result = await runWithExitCapture(
      "gusto employee add",
      async () => {
        handlerRan = true;
        return { ok: true, data: { uuid: "u1", email: "a@b.com" } };
      },
      { ...flags, fields: { mode: "select", keys: ["uuid"] } },
    );
    expect(handlerRan).toBe(true);
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, data: { uuid: "u1" } });
  });

  test("renders success data with the handler's human renderer in human mode", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({ ok: true, data: { name: "Acme" }, human: () => "Company: Acme" }),
      { ...flags, agent: false, human: true },
    );
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).toBe("Company: Acme\n");
  });

  test("ignores the human renderer when --fields selection is active", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({ ok: true, data: { name: "Acme", uuid: "co-1" }, human: () => "SHOULD NOT SHOW" }),
      { ...flags, agent: false, human: true, fields: { mode: "select", keys: ["name"] } },
    );
    expect(result.exitCode).toBe(ExitCode.Success);
    expect(result.stdout).not.toContain("SHOULD NOT SHOW");
    expect(result.stdout).toContain("Acme");
  });

  test("the human renderer never leaks into agent (JSON) output", async () => {
    const result = await runWithExitCapture(
      "test",
      async () => ({ ok: true, data: { name: "Acme" }, human: () => "SHOULD NOT SHOW" }),
      flags,
    );
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, data: { name: "Acme" } });
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
    const result = await handler({ ...ctx, globals: flags });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(ExitCode.General);
    expect(result.error.code).toBe("not_implemented");
    expect(result.error.message).toContain("gusto company provision");
  });
});

test("runner forwards a handler's next into the envelope", async () => {
  const result = await runWithExitCapture("t", async () => ({ ok: true, data: { employees: [] }, next: "CURSOR" }));
  expect(JSON.parse(result.stdout).next).toBe("CURSOR");
});
