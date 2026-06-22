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
});
