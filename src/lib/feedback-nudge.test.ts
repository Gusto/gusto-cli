import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ConfigPaths, writeConfig } from "./config.ts";
import { ExitCode } from "./exit-codes.ts";
import { NUDGE_THROTTLE_MS, feedbackNudge } from "./feedback-nudge.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { type CommandHandler, type CommandResult, runCommand } from "./runner.ts";
import { captureSinks } from "./test-support.ts";
import { VERSION } from "./version.ts";

let scratch: string;
let paths: ConfigPaths;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "gusto-cli-nudge-"));
  paths = { dir: scratch, file: path.join(scratch, "config.toml") };
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const agentFlags: GlobalFlags = { agent: true, human: false, json: false, verbose: false };
const humanFlags: GlobalFlags = { agent: false, human: true, json: false, verbose: false };

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function deps(now = NOW) {
  return { now: () => now, configPaths: () => paths };
}

/** A failed CommandResult with a Gusto API error code + request_id (the 422 friction shape). */
function apiError(code = "api_client_error"): CommandResult {
  return {
    ok: false,
    exitCode: ExitCode.ApiClient,
    error: { code, message: "boom", request_id: "req-abc-123" },
  };
}

/** Pull the single-quoted JSON `--context` payload back out of an agent-mode nudge string. */
function contextFrom(nudge: string): Record<string, unknown> {
  const m = nudge.match(/--context '(.*)'/);
  if (!m) throw new Error(`no --context in nudge: ${nudge}`);
  return JSON.parse(m[1] ?? "") as Record<string, unknown>;
}

describe("feedbackNudge — triggers", () => {
  test("fires on `gusto api request` success as escape_hatch/feature_request", async () => {
    const nudge = await feedbackNudge(
      { command: "gusto api request", globals: agentFlags, code: ExitCode.Success, result: { ok: true, data: {} } },
      deps(),
    );
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("--category feature_request");
    expect(contextFrom(nudge as string).trigger).toBe("escape_hatch");
  });

  test("fires on a failing command as friction/bug, carrying request_id + error_code", async () => {
    const nudge = await feedbackNudge(
      { command: "gusto employee list", globals: agentFlags, code: ExitCode.ApiClient, result: apiError() },
      deps(),
    );
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("--category bug");
    const ctx = contextFrom(nudge as string);
    expect(ctx.trigger).toBe("friction");
    expect(ctx.request_id).toBe("req-abc-123");
    expect(ctx.error_code).toBe("api_client_error");
  });

  test("human mode prints a short pointer line with no JSON context", async () => {
    const nudge = await feedbackNudge(
      { command: "gusto employee list", globals: humanFlags, code: ExitCode.ApiClient, result: apiError() },
      deps(),
    );
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("gusto feedback");
    expect(nudge).toContain("--category bug");
    expect(nudge).not.toContain("--context");
  });
});

describe("feedbackNudge — suppression", () => {
  test("never nudges from `gusto feedback` itself", async () => {
    const nudge = await feedbackNudge(
      { command: "gusto feedback", globals: agentFlags, code: ExitCode.ApiClient, result: apiError() },
      deps(),
    );
    expect(nudge).toBeNull();
  });

  test("never nudges from a `gusto config` command", async () => {
    const nudge = await feedbackNudge(
      {
        command: "gusto config set",
        globals: agentFlags,
        code: ExitCode.Validation,
        result: apiError("invalid_value"),
      },
      deps(),
    );
    expect(nudge).toBeNull();
  });

  test("never nudges from `gusto auth login`", async () => {
    const nudge = await feedbackNudge(
      { command: "gusto auth login", globals: agentFlags, code: ExitCode.Auth, result: apiError("auth_failed") },
      deps(),
    );
    expect(nudge).toBeNull();
  });

  test("does not treat a confirmation_required block (exit 8) as friction", async () => {
    const nudge = await feedbackNudge(
      {
        command: "gusto api request",
        globals: agentFlags,
        code: ExitCode.Blocked,
        result: { ok: false, exitCode: ExitCode.Blocked, error: { code: "confirmation_required", message: "nope" } },
      },
      deps(),
    );
    expect(nudge).toBeNull();
  });

  test("does not nudge a dry-run (`gusto api request --dry-run`)", async () => {
    const nudge = await feedbackNudge(
      {
        command: "gusto api request",
        globals: agentFlags,
        code: ExitCode.Success,
        result: { ok: true, dryRun: true, data: {} },
      },
      deps(),
    );
    expect(nudge).toBeNull();
  });

  test("does not nudge a plain successful read (no trigger)", async () => {
    const nudge = await feedbackNudge(
      { command: "gusto employee list", globals: agentFlags, code: ExitCode.Success, result: { ok: true, data: [] } },
      deps(),
    );
    expect(nudge).toBeNull();
  });
});

describe("feedbackNudge — throttle + opt-out", () => {
  test("suppresses a second same-category nudge inside 24h, then re-fires after the window", async () => {
    const inputs = {
      command: "gusto employee list",
      globals: agentFlags,
      code: ExitCode.ApiClient,
      result: apiError(),
    };
    const first = await feedbackNudge(inputs, deps(NOW));
    expect(first).not.toBeNull();

    const secondSoon = await feedbackNudge(inputs, deps(NOW + NUDGE_THROTTLE_MS - 1000));
    expect(secondSoon).toBeNull();

    const afterWindow = await feedbackNudge(inputs, deps(NOW + NUDGE_THROTTLE_MS + 1000));
    expect(afterWindow).not.toBeNull();
  });

  test("throttles each category independently", async () => {
    const friction = {
      command: "gusto employee list",
      globals: agentFlags,
      code: ExitCode.ApiClient,
      result: apiError(),
    };
    const escapeHatch = {
      command: "gusto api request",
      globals: agentFlags,
      code: ExitCode.Success,
      result: { ok: true, data: {} } as CommandResult,
    };
    expect(await feedbackNudge(friction, deps(NOW))).not.toBeNull();
    // A different category is not throttled by the first.
    expect(await feedbackNudge(escapeHatch, deps(NOW))).not.toBeNull();
    // ...but the same category now is.
    expect(await feedbackNudge(friction, deps(NOW))).toBeNull();
  });

  test("`feedback_nudge = never` disables the nudge entirely", async () => {
    await writeConfig({ feedback_nudge: "never" }, paths);
    const nudge = await feedbackNudge(
      { command: "gusto api request", globals: agentFlags, code: ExitCode.Success, result: { ok: true, data: {} } },
      deps(),
    );
    expect(nudge).toBeNull();
  });

  test("`feedback_nudge = always` leaves the nudge enabled", async () => {
    await writeConfig({ feedback_nudge: "always" }, paths);
    const nudge = await feedbackNudge(
      { command: "gusto api request", globals: agentFlags, code: ExitCode.Success, result: { ok: true, data: {} } },
      deps(),
    );
    expect(nudge).not.toBeNull();
  });
});

describe("feedbackNudge — context is a PII-safe allowlist", () => {
  test("carries only the allowlisted keys and nothing else", async () => {
    const nudge = await feedbackNudge(
      {
        command: "gusto employee list",
        globals: { ...agentFlags, env: "sandbox" },
        code: ExitCode.ApiClient,
        result: apiError(),
      },
      deps(),
    );
    const ctx = contextFrom(nudge as string);
    expect(Object.keys(ctx).sort()).toEqual(
      ["cli_version", "command", "environment", "error_code", "exit_code", "request_id", "trigger"].sort(),
    );
    expect(ctx.command).toBe("employee-list");
    expect(ctx.exit_code).toBe(ExitCode.ApiClient);
    expect(ctx.cli_version).toBe(VERSION);
    expect(ctx.environment).toBe("sandbox");
  });

  test("omits error_code and request_id on success, defaults environment to production", async () => {
    const nudge = await feedbackNudge(
      { command: "gusto api request", globals: agentFlags, code: ExitCode.Success, result: { ok: true, data: {} } },
      deps(),
    );
    const ctx = contextFrom(nudge as string);
    expect(ctx).not.toHaveProperty("error_code");
    expect(ctx).not.toHaveProperty("request_id");
    expect(ctx.environment).toBe("production");
    expect(ctx.command).toBe("api-request");
  });
});

describe("feedbackNudge via runCommand — stderr-only side channel", () => {
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_CONFIG_HOME;
    // configPaths() (used unmocked inside runCommand) reads XDG_CONFIG_HOME at call time.
    process.env.XDG_CONFIG_HOME = scratch;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  async function runCaptured(
    handler: CommandHandler,
    globals: GlobalFlags = agentFlags,
  ): Promise<{ stdout: string; stderr: string }> {
    const { sinks, stdout, stderr } = captureSinks();
    const exit = ((_code: number) => {
      throw new Error("__exit");
    }) as (code: number) => never;
    try {
      await runCommand("gusto api request", globals, handler, { exit, sinks, now: () => NOW });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "__exit") throw err;
    }
    return { stdout: stdout.buffer, stderr: stderr.buffer };
  }

  test("stdout stays byte-identical whether or not a nudge is emitted; the nudge lands on stderr", async () => {
    const handler: CommandHandler = async () => ({ ok: true, data: { hello: "world" } });

    const withNudge = await runCaptured(handler); // escape_hatch on api-request success → nudge
    await writeConfig({ feedback_nudge: "never" }, paths); // opt out for the second run
    const withoutNudge = await runCaptured(handler);

    expect(withNudge.stdout).toBe(withoutNudge.stdout);
    expect(withNudge.stdout).toContain('"ok":true');
    expect(withNudge.stderr).toContain("gusto feedback");
    expect(withoutNudge.stderr).toBe("");
  });
});
