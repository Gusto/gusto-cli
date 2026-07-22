import { describe, expect, test } from "bun:test";
import type { GlobalFlags } from "./global-flags.ts";
import { emit, outputOptionsFrom, resolveColor, resolveOutputMode } from "./output.ts";
import { captureSinks } from "./test-support.ts";

const defaultFlags: GlobalFlags = { agent: false, human: false, json: false, verbose: false };

describe("resolveOutputMode", () => {
  test("returns agent when --json is set", () => {
    expect(resolveOutputMode({ ...defaultFlags, json: true })).toBe("agent");
  });

  test("returns agent when --agent is set", () => {
    expect(resolveOutputMode({ ...defaultFlags, agent: true })).toBe("agent");
  });

  test("returns human when --human is set, even on non-TTY stdout", () => {
    expect(resolveOutputMode({ ...defaultFlags, human: true }, false)).toBe("human");
  });

  test("auto-detects agent when stdout is not a TTY", () => {
    expect(resolveOutputMode(defaultFlags, false)).toBe("agent");
  });

  test("auto-detects human when stdout is a TTY", () => {
    expect(resolveOutputMode(defaultFlags, true)).toBe("human");
  });

  test("--agent wins over --human if both somehow set", () => {
    expect(resolveOutputMode({ ...defaultFlags, agent: true, human: true })).toBe("agent");
  });
});

describe("resolveColor", () => {
  test("color is off in agent mode", () => {
    expect(resolveColor("agent", undefined, true)).toBe(false);
  });

  test("color is off when NO_COLOR is set", () => {
    expect(resolveColor("human", "1", true)).toBe(false);
  });

  test("empty NO_COLOR does not disable color", () => {
    expect(resolveColor("human", "", true)).toBe(true);
  });

  test("color is off in human mode when stdout is not a TTY", () => {
    expect(resolveColor("human", undefined, false)).toBe(false);
  });

  test("color is on in human mode when TTY and NO_COLOR unset", () => {
    expect(resolveColor("human", undefined, true)).toBe(true);
  });
});

describe("outputOptionsFrom", () => {
  test("passes verbose through", () => {
    const opts = outputOptionsFrom({ ...defaultFlags, verbose: true, json: true });
    expect(opts.verbose).toBe(true);
    expect(opts.mode).toBe("agent");
  });
});

describe("emit", () => {
  test("agent mode emits a single JSON line for success", () => {
    const { sinks, stdout, stderr } = captureSinks();
    emit({ mode: "agent", color: false, verbose: false }, { ok: true, data: { id: "x" } }, sinks);
    expect(stdout.buffer).toBe(`${JSON.stringify({ ok: true, data: { id: "x" } })}\n`);
    expect(stderr.buffer).toBe("");
  });

  test("agent mode emits the JSON envelope to stdout AND a human error line to stderr", () => {
    const { sinks, stdout, stderr } = captureSinks();
    emit({ mode: "agent", color: false, verbose: false }, { ok: false, error: { code: "x", message: "y" } }, sinks);
    expect(stdout.buffer).toBe(`${JSON.stringify({ ok: false, error: { code: "x", message: "y" } })}\n`);
    expect(stderr.buffer).toBe("error: y\n");
  });

  test("agent mode error also surfaces blocked_on details on stderr", () => {
    const { sinks, stderr } = captureSinks();
    emit(
      { mode: "agent", color: false, verbose: false },
      {
        ok: false,
        error: {
          code: "validation",
          message: "missing fields",
          blocked_on: [{ field: "ein", reason: "required" }],
        },
      },
      sinks,
    );
    expect(stderr.buffer).toBe("error: missing fields\nblocked on:\n  - ein: required\n");
  });

  test("surfaces the API's message from details as a reason line, right after the error line", () => {
    const { sinks, stderr } = captureSinks();
    emit(
      { mode: "human", color: false, verbose: false },
      {
        ok: false,
        error: {
          code: "api_client_error",
          message: "DELETE https://api.gusto.com/v1/employees/e-1/terminations -> 404",
          details: { errors: [{ category: "not_found", message: "The employee has not been terminated." }] },
        },
      },
      sinks,
    );
    expect(stderr.buffer).toBe(
      "error: DELETE https://api.gusto.com/v1/employees/e-1/terminations -> 404\n" +
        "reason: The employee has not been terminated.\n",
    );
  });

  test("joins multiple API error messages into one reason line", () => {
    const { sinks, stderr } = captureSinks();
    emit(
      { mode: "human", color: false, verbose: false },
      {
        ok: false,
        error: {
          code: "api_client_error",
          message: "POST /x -> 422",
          details: { errors: [{ message: "bad start_date" }, { message: "bad end_date" }] },
        },
      },
      sinks,
    );
    expect(stderr.buffer).toBe("error: POST /x -> 422\nreason: bad start_date; bad end_date\n");
  });

  test("suppresses the reason line when the error message already contains it", () => {
    const { sinks, stderr } = captureSinks();
    emit(
      { mode: "human", color: false, verbose: false },
      {
        ok: false,
        error: {
          code: "x",
          message: "your token is missing the scope this command needs",
          details: { errors: [{ message: "missing the scope" }] },
        },
      },
      sinks,
    );
    expect(stderr.buffer).toBe("error: your token is missing the scope this command needs\n");
  });

  test("does not surface non-errors-array detail shapes (no JSON dump to a human)", () => {
    const { sinks, stderr } = captureSinks();
    emit(
      { mode: "human", color: false, verbose: false },
      {
        ok: false,
        error: {
          code: "report_failed",
          message: "report r-1 failed",
          details: { response: { status: "failed", rows: [1, 2, 3] } },
        },
      },
      sinks,
    );
    expect(stderr.buffer).toBe("error: report r-1 failed\n");
  });

  test("orders the reason line before the hint line", () => {
    const { sinks, stderr } = captureSinks();
    emit(
      { mode: "human", color: false, verbose: false },
      {
        ok: false,
        error: {
          code: "api_client_error",
          message: "DELETE /x -> 404",
          details: { errors: [{ category: "not_found", message: "not terminated" }] },
          hint: "re-verify the uuid",
        },
      },
      sinks,
    );
    expect(stderr.buffer).toBe("error: DELETE /x -> 404\nreason: not terminated\nhint: re-verify the uuid\n");
  });

  test("agent mode surfaces did_you_mean, available commands, and hint on stderr", () => {
    const { sinks, stdout, stderr } = captureSinks();
    const error = {
      code: "unknown_command",
      message: "unknown command 'shwo' for 'gusto payroll'",
      valid_commands: ["list", "show"],
      did_you_mean: "show",
      hint: "for a read without a first-class command yet, use: gusto api request GET <path>",
    };
    emit({ mode: "agent", color: false, verbose: false }, { ok: false, error }, sinks);
    expect(stdout.buffer).toBe(`${JSON.stringify({ ok: false, error })}\n`);
    expect(stderr.buffer).toBe(
      "error: unknown command 'shwo' for 'gusto payroll'\n" +
        "did you mean: show?\n" +
        "available commands: list, show\n" +
        "hint: for a read without a first-class command yet, use: gusto api request GET <path>\n",
    );
  });

  test("human mode renders did_you_mean, available commands, and hint to stderr", () => {
    const { sinks, stderr } = captureSinks();
    emit(
      { mode: "human", color: false, verbose: false },
      {
        ok: false,
        error: {
          code: "unknown_command",
          message: "unknown command 'blork' for 'gusto company'",
          valid_commands: ["show", "locations"],
          hint: "for a read without a first-class command yet, use: gusto api request GET <path>",
        },
      },
      sinks,
    );
    expect(stderr.buffer).toContain("error: unknown command 'blork' for 'gusto company'");
    expect(stderr.buffer).not.toContain("did you mean");
    expect(stderr.buffer).toContain("available commands: show, locations");
    expect(stderr.buffer).toContain("hint: for a read without a first-class command yet");
  });

  test("human mode writes structured data as pretty JSON to stdout", () => {
    const { sinks, stdout } = captureSinks();
    emit({ mode: "human", color: false, verbose: false }, { ok: true, data: { id: "x" } }, sinks);
    expect(stdout.buffer).toBe(`${JSON.stringify({ id: "x" }, null, 2)}\n`);
  });

  test("human mode uses a provided renderer instead of pretty JSON", () => {
    const { sinks, stdout } = captureSinks();
    emit({ mode: "human", color: false, verbose: false }, { ok: true, data: { id: "x" } }, sinks, () => "rendered:x");
    expect(stdout.buffer).toBe("rendered:x\n");
  });

  test("agent mode ignores a provided human renderer", () => {
    const { sinks, stdout } = captureSinks();
    emit(
      { mode: "agent", color: false, verbose: false },
      { ok: true, data: { id: "x" } },
      sinks,
      () => "should not appear",
    );
    expect(stdout.buffer).toBe(`${JSON.stringify({ ok: true, data: { id: "x" } })}\n`);
  });

  test("human mode writes scalars as plain strings", () => {
    const { sinks, stdout } = captureSinks();
    emit({ mode: "human", color: false, verbose: false }, { ok: true, data: "hello" }, sinks);
    expect(stdout.buffer).toBe("hello\n");
  });

  test("human mode error writes to stderr with blocked_on details", () => {
    const { sinks, stdout, stderr } = captureSinks();
    emit(
      { mode: "human", color: false, verbose: false },
      {
        ok: false,
        error: {
          code: "validation",
          message: "missing fields",
          blocked_on: [{ field: "ein", reason: "required" }],
        },
      },
      sinks,
    );
    expect(stdout.buffer).toBe("");
    expect(stderr.buffer).toContain("error: missing fields");
    expect(stderr.buffer).toContain("blocked on:");
    expect(stderr.buffer).toContain("ein: required");
  });

  test("agent mode success with no data still emits an envelope", () => {
    const { sinks, stdout } = captureSinks();
    emit({ mode: "agent", color: false, verbose: false }, { ok: true }, sinks);
    expect(stdout.buffer).toBe(`${JSON.stringify({ ok: true })}\n`);
  });

  test("agent mode includes next in the JSON envelope", () => {
    const { sinks, stdout } = captureSinks();
    emit({ mode: "agent", color: false, verbose: false }, { ok: true, data: [1, 2], next: "CURSOR" }, sinks);
    expect(JSON.parse(stdout.buffer)).toEqual({ ok: true, data: [1, 2], next: "CURSOR" });
  });

  test("human mode prints a more-results hint to stderr when next is set", () => {
    const { sinks, stderr } = captureSinks();
    emit({ mode: "human", color: false, verbose: false }, { ok: true, data: [1], next: "CURSOR" }, sinks);
    expect(stderr.buffer).toContain("--cursor CURSOR");
  });

  test("human mode prints no hint when next is absent", () => {
    const { sinks, stderr } = captureSinks();
    emit({ mode: "human", color: false, verbose: false }, { ok: true, data: [1] }, sinks);
    expect(stderr.buffer).toBe("");
  });
});
