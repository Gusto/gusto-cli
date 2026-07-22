import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Run, spawnCapture } from "./support";
import pkg from "../package.json" with { type: "json" };

const BIN_PATH = path.resolve(import.meta.dir, "..", "dist", "gusto");

// Isolate the credential store so smoke runs never read the developer's real
// ~/.config/gusto (and so token-dependent commands stay deterministic).
const ISOLATED_CONFIG = mkdtempSync(path.join(tmpdir(), "gusto-cli-smoke-"));

async function run(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<Run> {
  return spawnCapture(
    [BIN_PATH, ...args],
    { ...stripGustoEnv(process.env), XDG_CONFIG_HOME: ISOLATED_CONFIG, ...env },
    { stdin },
  );
}

function stripGustoEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !k.startsWith("GUSTO_")) out[k] = v;
  }
  return out;
}

describe("compiled binary", () => {
  beforeAll(() => {
    if (!existsSync(BIN_PATH)) {
      throw new Error(`Binary not found at ${BIN_PATH}. Run \`bun run build\` first.`);
    }
  });

  test("--version prints the version and exits 0", async () => {
    const result = await run(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test("--help lists all top-level commands and exits 0", async () => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    for (const cmd of [
      "company",
      "employee",
      "contractor",
      "pay-schedule",
      "payroll",
      "ledger",
      "report",
      "auth",
      "skill",
      "config",
      "api",
    ]) {
      expect(result.stdout).toContain(cmd);
    }
  });

  test("unknown command exits 2", async () => {
    const result = await run(["this-command-does-not-exist"]);
    expect(result.exitCode).toBe(2);
  });

  test("--env validates choices", async () => {
    const result = await run(["--env", "staging", "auth", "whoami"]);
    expect(result.exitCode).toBe(2);
  });
});

describe("auth required commands without a token", () => {
  test("employee list without GUSTO_ACCESS_TOKEN returns no_access_token (exit 3)", async () => {
    const result = await run(["employee", "list"]);
    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("no_access_token");
  });

  test("auth whoami without token returns no_access_token", async () => {
    const result = await run(["auth", "whoami"]);
    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("no_access_token");
  });

  test("employee status <uuid> without a token returns no_access_token (exit 3)", async () => {
    const result = await run(["employee", "status", "emp-123"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  // The three address reads dispatch their handlers (reaching the auth check, exit 3) rather than
  // hitting commander's "unknown command" (exit 2) - proof each new subcommand is wired.
  test.each([
    ["addresses", ["employee", "addresses", "emp-123"]],
    ["work-address", ["employee", "work-address", "wa-123"]],
    ["home-address", ["employee", "home-address", "ha-123"]],
  ])("employee %s <uuid> without a token returns no_access_token (exit 3)", async (_name, argv) => {
    const result = await run(argv);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("pay-schedule list dispatches its handler instead of erroring", async () => {
    // Without a token the list handler still exits 3 (no_access_token); the win is
    // reaching the handler at all rather than commander's "unknown command" (exit 2).
    const result = await run(["pay-schedule", "list"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("pay-schedule assignments dispatches its handler instead of erroring", async () => {
    const result = await run(["pay-schedule", "assignments"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("pay-schedule get <uuid> (alias for show) dispatches the show handler instead of erroring", async () => {
    // `get` aliases `show <uuid>`; pass a uuid so we reach the handler rather than the
    // missing-argument validation error (exit 7). Without a token the handler exits 3.
    const result = await run(["pay-schedule", "get", "ps-1"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("company get (alias for show) dispatches the show handler instead of erroring", async () => {
    // Agents reach for `company get` first; the alias means they hit the show
    // handler (exit 3 no_access_token without a token) rather than commander's
    // "unknown command 'get'" (exit 2) that would stop them.
    const result = await run(["company", "get"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  // The `get` alias is wired onto every read entity's `show`, so an agent's near-universal `get`
  // guess dispatches the show handler (exit 3 without a token) instead of commander's unknown-command
  // (exit 2) that would stop it. company + pay-schedule are covered above; the rest here.
  test.each([
    ["employee", ["employee", "get", "employee-uuid-123"]],
    ["contractor", ["contractor", "get", "contractor-uuid-123"]],
    ["payroll", ["payroll", "get", "payroll-uuid-123"]],
    ["ledger", ["ledger", "get", "payroll-uuid-123"]],
    ["timesheet", ["timesheet", "get", "time-sheet-uuid-123"]],
  ])("%s get (alias for show) dispatches the show handler instead of erroring", async (_name, argv) => {
    const result = await run(argv);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("payroll list without a token returns no_access_token (exit 3)", async () => {
    const result = await run(["payroll", "list"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("payroll blockers without a token returns no_access_token (exit 3)", async () => {
    const result = await run(["payroll", "blockers"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("payroll calculate with a uuid and --confirm but no token returns no_access_token (exit 3)", async () => {
    // calculate is a gated write, so --confirm is needed to get past the agent-mode confirmation
    // gate and reach the auth check this asserts (without it the run blocks with exit 8 first).
    const result = await run(["payroll", "calculate", "payroll-uuid-123", "--confirm"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("ledger show without a token returns no_access_token (exit 3)", async () => {
    const result = await run(["ledger", "show", "payroll-uuid-123"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("ledger show --no-wait still needs a token (POSTs the report request)", async () => {
    const result = await run(["ledger", "show", "payroll-uuid-123", "--no-wait"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("report run without a token returns no_access_token (exit 3)", async () => {
    const result = await run(["report", "run", "--columns", "net_pay"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("report get without a token returns no_access_token (exit 3)", async () => {
    const result = await run(["report", "get", "req-uuid-123"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });
});

describe("usage errors are self-correcting envelopes in agent mode", () => {
  test("an unknown subcommand returns a parseable unknown_command envelope (exit 2)", async () => {
    // `payroll frobnicate` has no first-class command; instead of commander's bare stderr line, an
    // agent gets a {ok:false} envelope on stdout listing the valid subcommands and the api-hatch
    // fallback, so it can self-correct rather than dead-end.
    const result = await run(["payroll", "frobnicate"]);
    expect(result.exitCode).toBe(2);
    const env = JSON.parse(result.stdout.trim());
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("unknown_command");
    expect(env.error.valid_commands).toContain("show");
    expect(env.error.hint).toContain("gusto api request GET");
  });

  test("a typo'd top-level command suggests the nearest match", async () => {
    const result = await run(["compant"]);
    expect(result.exitCode).toBe(2);
    const env = JSON.parse(result.stdout.trim());
    expect(env.error.code).toBe("unknown_command");
    expect(env.error.did_you_mean).toBe("company");
  });

  test("an unknown option is a structured unknown_option envelope pointing at --help, not the hatch", async () => {
    const result = await run(["company", "show", "--nope"]);
    expect(result.exitCode).toBe(2);
    const env = JSON.parse(result.stdout.trim());
    expect(env.error.code).toBe("unknown_option");
    expect(env.error.valid_commands).toBeUndefined();
    expect(env.error.hint).toBe("run `gusto --help` for usage");
  });

  test("a missing required argument returns the documented blocked_on envelope (exit 7)", async () => {
    // CLAUDE.md: missing required args return a blocked_on envelope (exit 7). commander raises these
    // for required positionals (e.g. `contractor show <contractor_uuid>`) before the handler runs, so
    // route them through the same validation shape the handlers use rather than a bare exit-2 line.
    const result = await run(["contractor", "show"]);
    expect(result.exitCode).toBe(7);
    const env = JSON.parse(result.stdout.trim());
    expect(env.error.code).toBe("validation");
    expect(env.error.blocked_on).toEqual([{ field: "contractor_uuid", reason: "required" }]);
  });

  test("a command group with no subcommand still prints help (exit 0), not an envelope", async () => {
    const result = await run(["company"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("Commands:");
  });
});

describe("payroll/ledger validate before auth (exit 7)", () => {
  test("payroll list with a malformed --start-date blocks on start-date", async () => {
    const result = await run(["payroll", "list", "--start-date", "01-01-2026"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "start-date" }));
  });

  test("payroll list with an invalid --sort-order blocks on sort-order", async () => {
    const result = await run(["payroll", "list", "--sort-order", "sideways"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "sort-order" }));
  });

  test("payroll calculate without a payroll_uuid blocks on payroll_uuid", async () => {
    const result = await run(["payroll", "calculate"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "payroll_uuid" }));
  });

  test("ledger show with a non-positive --timeout blocks on timeout", async () => {
    const result = await run(["ledger", "show", "payroll-uuid-123", "--timeout", "0"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "timeout" }));
  });

  test("report run with a malformed --to date blocks on to (before auth)", async () => {
    const result = await run(["report", "run", "--columns", "net_pay", "--to", "03-31-2026"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "to" }));
  });

  test("report run without --columns blocks on columns (validation/exit 7, not cli_usage)", async () => {
    const result = await run(["report", "run"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "columns" }));
  });

  test("report run with an all-empty --columns list blocks on columns (must list at least one)", async () => {
    const result = await run(["report", "run", "--columns", ",,,"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(
      expect.objectContaining({ field: "columns", reason: "must list at least one column" }),
    );
  });
});

describe("dry-run works without auth", () => {
  test("pay-schedule create --dry-run emits the would-be request even without a token", async () => {
    const result = await run([
      "pay-schedule",
      "create",
      "--frequency",
      "weekly",
      "--first-payday",
      "2026-07-03",
      "--anchor-end-of-pay-period",
      "2026-06-26",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.method).toBe("POST");
    expect(envelope.data.body.frequency).toBe("Every week");
  });

  test("pay-schedule create maps every frequency alias to its canonical Gusto value", async () => {
    const cases: [string, string][] = [
      ["weekly", "Every week"],
      ["biweekly", "Every other week"],
      ["bi-weekly", "Every other week"],
      ["semi-monthly", "Twice per month"],
      ["semimonthly", "Twice per month"],
      ["monthly", "Monthly"],
    ];
    for (const [alias, canonical] of cases) {
      const result = await run([
        "pay-schedule",
        "create",
        "--frequency",
        alias,
        "--first-payday",
        "2026-07-03",
        "--anchor-end-of-pay-period",
        "2026-06-26",
        // Required by month-based frequencies; ignored by the week-based ones.
        "--day-1",
        "15",
        "--day-2",
        "30",
        "--dry-run",
      ]);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout.trim()).data.body;
      expect(body.frequency).toBe(canonical);
      expect(body.anchor_pay_date).toBe("2026-07-03");
    }
  });

  test("pay-schedule create accepts --anchor-pay-date as an alias for --first-payday", async () => {
    const result = await run([
      "pay-schedule",
      "create",
      "--frequency",
      "weekly",
      "--anchor-pay-date",
      "2026-07-03",
      "--anchor-end-of-pay-period",
      "2026-06-26",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.body.frequency).toBe("Every week");
    expect(envelope.data.body.anchor_pay_date).toBe("2026-07-03");
  });
});

describe("validation returns structured blocked_on before auth (exit 7)", () => {
  test("pay-schedule create with no args blocks on frequency and first-payday", async () => {
    const result = await run(["pay-schedule", "create"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "frequency" }));
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "first-payday" }));
  });

  test("pay-schedule create with an unknown frequency blocks on frequency", async () => {
    const result = await run(["pay-schedule", "create", "--frequency", "fortnightly", "--first-payday", "2026-07-03"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    const freq = envelope.error.blocked_on.find((b: { field: string }) => b.field === "frequency");
    expect(freq.reason).toMatch(/unknown frequency/);
  });

  test("api request with an unsupported method returns unsupported_method", async () => {
    const result = await run(["api", "request", "BLAH", "/v1/me"]);
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("unsupported_method");
  });
});

describe("--example prints canonical payloads without auth or args", () => {
  test("pay-schedule create --example", async () => {
    const result = await run(["pay-schedule", "create", "--example"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.body.frequency).toBeTruthy();
    expect(envelope.data.body.anchor_pay_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("config commands work without auth", () => {
  let scratchHome: string;

  beforeEach(() => {
    scratchHome = mkdtempSync(path.join(tmpdir(), "gusto-cli-smoke-config-"));
  });

  afterEach(() => {
    rmSync(scratchHome, { recursive: true, force: true });
  });

  test("set + get + list + reset round-trip", async () => {
    const env = { XDG_CONFIG_HOME: scratchHome };

    let result = await run(["config", "set", "environment", "sandbox"], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim()).data.value).toBe("sandbox");

    result = await run(["config", "get", "environment"], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim()).data.value).toBe("sandbox");

    result = await run(["config", "list"], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim()).data.values.environment).toBe("sandbox");

    result = await run(["config", "reset"], env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim()).data.reset).toBe(true);

    result = await run(["config", "get", "environment"], env);
    expect(JSON.parse(result.stdout.trim()).data.value).toBeNull();
  });

  test("config set rejects unknown keys", async () => {
    const result = await run(["config", "set", "nope", "sandbox"], { XDG_CONFIG_HOME: scratchHome });
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("unknown_key");
  });

  test("config set rejects invalid values", async () => {
    const result = await run(["config", "set", "environment", "staging"], { XDG_CONFIG_HOME: scratchHome });
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("invalid_value");
  });

  test("config set format json is normalized to agent on the way to disk", async () => {
    const env = { XDG_CONFIG_HOME: scratchHome };

    const set = await run(["config", "set", "format", "json"], env);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout.trim()).data.value).toBe("agent");

    const get = await run(["config", "get", "format"], env);
    expect(JSON.parse(get.stdout.trim()).data.value).toBe("agent");
  });

  test("config set rejects an invalid format and lists json in the error", async () => {
    const result = await run(["config", "set", "format", "bogus"], { XDG_CONFIG_HOME: scratchHome });
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("invalid_value");
    expect(envelope.error.message).toContain("json");
  });
});

describe("skill commands work without auth", () => {
  test("skill list shows bundled skills", async () => {
    const result = await run(["skill", "list"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.skills).toContainEqual(expect.objectContaining({ name: "cash-forecasting" }));
  });

  test("skill install cash-forecasting installs the bundled skill", async () => {
    const { mkdirSync, existsSync: exists, readFileSync, realpathSync } = await import("node:fs");
    const scratchRaw = mkdtempSync(path.join(tmpdir(), "gusto-cli-smoke-skill-"));
    const scratch = realpathSync(scratchRaw);
    try {
      const target = path.join(scratch, ".claude", "skills");
      mkdirSync(target, { recursive: true });
      const proc = Bun.spawn([BIN_PATH, "skill", "install", "cash-forecasting"], {
        cwd: scratch,
        stdout: "pipe",
        stderr: "pipe",
        env: stripGustoEnv(process.env),
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      const installed = path.join(target, "cash-forecasting", "SKILL.md");
      expect(exists(installed)).toBe(true);
      expect(readFileSync(installed, "utf8")).toContain("user-invocable: true");
      expect(JSON.parse(stdout.trim()).data.installedAt).toBe(installed);
    } finally {
      rmSync(scratchRaw, { recursive: true, force: true });
    }
  });
});

describe("--fields filters success output", () => {
  test("api request --dry-run --fields method,path keeps only those keys", async () => {
    const result = await run([
      "api",
      "request",
      "POST",
      "/v1/things",
      "--data",
      '{"name":"thing"}',
      "--dry-run",
      "--fields",
      "method,path",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(Object.keys(envelope.data)).toEqual(["method", "path"]);
  });

  test("pay-schedule create --fields (no value) rejects discovery on a write command, exit 2", async () => {
    // Bare `--fields` (discovery) is gated to read commands; it must not run a mutating handler
    // just to introspect output. `--example` doesn't change that — `pay-schedule create` is a
    // write command either way, so discovery is rejected before the handler runs.
    const result = await run(["pay-schedule", "create", "--example", "--fields"]);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("fields_discovery_unsupported");
  });

  test("skill list --fields (no value) lists available fields on stderr, exit 1 (read-command discovery)", async () => {
    // Exercises the runReadCommand discovery path end-to-end through the compiled binary on a
    // read command that needs no auth or network — bare `--fields` lists fields and exits 1.
    const result = await run(["skill", "list", "--fields"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("skills");
  });
});

describe("api request", () => {
  test("--dry-run prints the would-be request without needing a token", async () => {
    const result = await run(["api", "request", "POST", "/v1/things", "--data", '{"name":"thing"}', "--dry-run"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data).toEqual({ method: "POST", path: "/v1/things", body: { name: "thing" } });
  });

  test("invalid JSON in --data is rejected with validation exit code", async () => {
    const result = await run(["api", "request", "POST", "/v1/things", "--data", "{not json", "--dry-run"]);
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("invalid_json");
  });

  test("--dry-run substitutes {company_uuid} from GUSTO_COMPANY_UUID into the path", async () => {
    const result = await run(["api", "request", "GET", "/v1/companies/{company_uuid}/employees", "--dry-run"], {
      GUSTO_ACCESS_TOKEN: "tok",
      GUSTO_COMPANY_UUID: "co-1",
    });
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.path).toBe("/v1/companies/co-1/employees");
    expect(envelope.data.note).toBeUndefined();
  });

  test("--dry-run with {company_uuid} but no company keeps the placeholder and notes it", async () => {
    const result = await run(["api", "request", "GET", "/v1/companies/{company_uuid}/employees", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.path).toBe("/v1/companies/{company_uuid}/employees");
    expect(envelope.data.note).toBeTruthy();
  });

  test("--company-uuid on a path with no placeholder warns on stderr but still succeeds", async () => {
    const result = await run(["api", "request", "GET", "/v1/me", "--company-uuid", "co-1", "--dry-run"]);
    expect(result.exitCode).toBe(0);
    // stdout stays a clean JSON envelope; the warning goes to stderr.
    expect(JSON.parse(result.stdout.trim()).data.path).toBe("/v1/me");
    expect(result.stderr).toMatch(/--company-uuid/);
    expect(result.stderr).toContain("{company_uuid}");
  });

  test("--auto-version on a non-PUT/PATCH method is a validation error", async () => {
    const result = await run(["api", "request", "GET", "/v1/things", "--auto-version", "--dry-run"]);
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("auto_version_unsupported");
  });

  test("--dry-run --auto-version notes the version is resolved at send time", async () => {
    const result = await run([
      "api",
      "request",
      "PUT",
      "/v1/things/1",
      "--data",
      '{"x":1}',
      "--auto-version",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.body).toEqual({ x: 1 });
    expect(envelope.data.note).toMatch(/version.*send time/i);
  });
});

// The inline `--token <value>` flag was dropped (it leaks secrets into
// ps/shell history/audit logs). Tokens now come from a stored session, the
// GUSTO_ACCESS_TOKEN env var, or `--token-stdin`.
describe("token-stdin authentication", () => {
  test("the removed --token <value> flag is rejected as an unknown option (exit 2)", async () => {
    const result = await run(["employee", "list", "--token", "abc"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  test("help advertises --token-stdin and no longer mentions --token <token>", async () => {
    const result = await run(["employee", "list", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--token-stdin");
    expect(result.stdout).not.toContain("--token <");
  });

  test("a token piped to --token-stdin resolves auth (no session/env present)", async () => {
    // No stored session (isolated config) and no GUSTO_ACCESS_TOKEN, so a piped token
    // is the only possible source. A dry-run create interpolates the real company path
    // (and drops the "not required" note) only when auth actually resolved - so this
    // proves the piped token was used, with no network call.
    const result = await run(
      [
        "pay-schedule",
        "create",
        "--frequency",
        "weekly",
        "--first-payday",
        "2026-07-03",
        "--anchor-end-of-pay-period",
        "2026-06-26",
        "--token-stdin",
        "--dry-run",
      ],
      { GUSTO_COMPANY_UUID: "co-1" },
      "piped-secret-token\n",
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.path).toBe("/v1/companies/co-1/pay_schedules");
    expect(envelope.data.note).toBeUndefined();
  });

  test("without --token-stdin (and no session/env) the same dry-run reports token not required", async () => {
    // Mirror of the above with no token source: auth fails, so the dry-run falls back to
    // the placeholder path and the explanatory note - confirming stdin wasn't read.
    const result = await run(
      [
        "pay-schedule",
        "create",
        "--frequency",
        "weekly",
        "--first-payday",
        "2026-07-03",
        "--anchor-end-of-pay-period",
        "2026-06-26",
        "--dry-run",
      ],
      { GUSTO_COMPANY_UUID: "co-1" },
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.path).toBe("/v1/companies/{company_uuid}/pay_schedules");
    expect(envelope.data.note).toContain("token/company not required");
  });
});

describe("the pulled employee/contractor write surface is gone", () => {
  // AINT-713 dropped these from the production surface; commander should reject them
  // outright (exit 2) rather than reach a handler.
  for (const args of [
    ["employee", "add", "personal-details"],
    ["employee", "manage", "emp-123"],
    ["employee", "delete", "emp-123"],
    ["employee", "job", "delete", "job-123"],
    ["contractor", "add", "--type", "individual"],
  ]) {
    test(`\`${args.join(" ")}\` is an unknown command (exit 2)`, async () => {
      const result = await run(args);
      expect(result.exitCode).toBe(2);
    });
  }

  test("employee/contractor reads still work (list returns no_access_token, not unknown command)", async () => {
    for (const cmd of [
      ["employee", "list"],
      ["contractor", "list"],
    ]) {
      const result = await run(cmd);
      expect(result.exitCode).toBe(3);
      expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
    }
  });
});
