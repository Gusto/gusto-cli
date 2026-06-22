import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Run, spawnCapture } from "./support";

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
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
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

  test("pay-schedule list (alias for show) dispatches the show handler instead of erroring", async () => {
    // Without a token the show handler still exits 3 (no_access_token); the win is
    // not getting commander's "unknown command 'list'" (exit 2) before we ever reach it.
    const result = await run(["pay-schedule", "list"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("payroll list without a token returns no_access_token (exit 3)", async () => {
    const result = await run(["payroll", "list"]);
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

  test("ledger show with a non-positive --timeout blocks on timeout", async () => {
    const result = await run(["ledger", "show", "payroll-uuid-123", "--timeout", "0"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "timeout" }));
  });
});

describe("company provision input handling (offline)", () => {
  test("no --input/--example is a missing-args validation envelope", async () => {
    const result = await run(["company", "provision"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "input" }));
  });

  test("--dry-run --example emits the unwrapped request without auth", async () => {
    const result = await run(["company", "provision", "--dry-run", "--example"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.path).toBe("/v1/provision");
    expect(envelope.data.body.user).toBeDefined();
    expect(envelope.data.body.company).toBeDefined();
  });
});

describe("dry-run works without auth", () => {
  test("employee add --dry-run emits the would-be request even without a token", async () => {
    const result = await run([
      "employee",
      "add",
      "personal-details",
      "--first-name",
      "Jane",
      "--last-name",
      "Doe",
      "--email",
      "j@example.com",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.method).toBe("POST");
    expect(envelope.data.body.email).toBe("j@example.com");
  });

  test("company finish --dry-run lists only finish_onboarding without a token", async () => {
    const result = await run(["company", "finish", "--dry-run", "--company-uuid", "co-1"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.steps.map((s: { path: string }) => s.path)).toEqual([
      "/v1/companies/{company_uuid}/finish_onboarding",
    ]);
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

  test("employee add personal-details validates required args before auth", async () => {
    const result = await run(["employee", "add", "personal-details", "--first-name", "Jane"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "last-name" }));
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("employee add personal-details with all required args + no token returns no_access_token", async () => {
    const result = await run([
      "employee",
      "add",
      "personal-details",
      "--first-name",
      "Jane",
      "--last-name",
      "Doe",
      "--email",
      "j@x.com",
    ]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });
});

describe("employee add per-domain subcommands", () => {
  const EMP = "emp-123";

  test("home-address --dry-run emits the POST without auth", async () => {
    const result = await run([
      "employee",
      "add",
      "home-address",
      EMP,
      "--street-1",
      "300 3rd St",
      "--city",
      "San Francisco",
      "--state",
      "CA",
      "--zip",
      "94107",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout.trim()).data;
    expect(data.method).toBe("POST");
    expect(data.path).toBe(`/v1/employees/${EMP}/home_addresses`);
    expect(data.body.street_1).toBe("300 3rd St");
  });

  test("job with compensation --dry-run emits the ordered steps plan", async () => {
    const result = await run([
      "employee",
      "add",
      "job",
      EMP,
      "--title",
      "Engineer",
      "--hire-date",
      "2026-01-06",
      "--rate",
      "120000",
      "--payment-unit",
      "Year",
      "--flsa-status",
      "Exempt",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout.trim()).data;
    expect(data.steps.map((s: { method: string; path: string }) => `${s.method} ${s.path}`)).toEqual([
      `POST /v1/employees/${EMP}/jobs`,
      "PUT /v1/compensations/{compensation_uuid}",
    ]);
  });

  test("federal-tax --dry-run emits the version-guarded PUT", async () => {
    const result = await run([
      "employee",
      "add",
      "federal-tax",
      EMP,
      "--filing-status",
      "Single",
      "--w4-data-type",
      "rev_2020_w4",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout.trim()).data;
    expect(data.method).toBe("PUT");
    expect(data.path).toBe(`/v1/employees/${EMP}/federal_taxes`);
    expect(data.body.filing_status).toBe("Single");
  });

  test("payment-method direct-deposit --dry-run emits create-bank then set-method steps", async () => {
    const result = await run([
      "employee",
      "add",
      "payment-method",
      EMP,
      "--type",
      "direct-deposit",
      "--name",
      "Checking",
      "--routing-number",
      "266905059",
      "--account-number",
      "5809431207",
      "--account-type",
      "Checking",
      "--dry-run",
    ]);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout.trim()).data;
    expect(data.steps.map((s: { method: string; path: string }) => `${s.method} ${s.path}`)).toEqual([
      `POST /v1/employees/${EMP}/bank_accounts`,
      `PUT /v1/employees/${EMP}/payment_method`,
    ]);
  });

  test("home-address with no fields blocks before auth (exit 7)", async () => {
    const result = await run(["employee", "add", "home-address", EMP, "--dry-run"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "street-1" }));
  });

  test("payment-method direct-deposit without the bank fields blocks (exit 7)", async () => {
    const result = await run(["employee", "add", "payment-method", EMP, "--type", "direct-deposit", "--dry-run"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "routing-number" }));
  });

  test("state-tax with a malformed --answer blocks before auth (exit 7)", async () => {
    const result = await run(["employee", "add", "state-tax", EMP, "--answer", "bogus"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "answer" }));
  });

  test("employee status <uuid> without a token returns no_access_token (exit 3)", async () => {
    const result = await run(["employee", "status", "emp-123"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
  });

  test("an optional-positional subcommand missing [employee_uuid] returns blocked_on (exit 7)", async () => {
    // Every `employee add` subcommand takes [employee_uuid] so --example needs no uuid;
    // a non-example call without it falls to missingEmployeeUuid() rather than a commander error.
    const result = await run(["employee", "add", "job", "--title", "X", "--hire-date", "2026-01-06"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "employee_uuid" }));
  });

  test("home-address and work-address (formerly <required>, now [optional]) also return blocked_on", async () => {
    const home = await run(["employee", "add", "home-address", "--street-1", "X"]);
    expect(home.exitCode).toBe(7);
    expect(JSON.parse(home.stdout.trim()).error.blocked_on).toContainEqual(
      expect.objectContaining({ field: "employee_uuid" }),
    );
    const work = await run(["employee", "add", "work-address", "--effective-date", "2026-01-01"]);
    expect(work.exitCode).toBe(7);
    expect(JSON.parse(work.stdout.trim()).error.blocked_on).toContainEqual(
      expect.objectContaining({ field: "employee_uuid" }),
    );
  });

  test("--example on home-address / work-address prints canned payload without an employee_uuid", async () => {
    const home = JSON.parse((await run(["employee", "add", "home-address", "--example"])).stdout.trim());
    expect(home.ok).toBe(true);
    expect(home.data.method).toBe("POST");
    expect(home.data.path).toBe("/v1/employees/{employee_uuid}/home_addresses");
    expect(home.data.body).toMatchObject({ street_1: expect.any(String), city: expect.any(String), state: "CA" });
    const work = JSON.parse((await run(["employee", "add", "work-address", "--example"])).stdout.trim());
    expect(work.ok).toBe(true);
    expect(work.data.method).toBe("POST");
    expect(work.data.path).toBe("/v1/employees/{employee_uuid}/work_addresses");
    expect(work.data.body).toMatchObject({ location_uuid: expect.any(String), effective_date: expect.any(String) });
  });
});

describe("validation returns structured blocked_on before auth (exit 7)", () => {
  test("contractor add without --type blocks on type", async () => {
    const result = await run(["contractor", "add", "--email", "sam@example.com"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "type" }));
  });

  test("contractor add --type individual blocks on missing names, wage, and start date", async () => {
    const result = await run(["contractor", "add", "--type", "individual"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "first-name" }));
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "last-name" }));
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "wage-type" }));
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "start-date" }));
    // Admin-driven is the default, so email is not required here.
    expect(envelope.error.blocked_on).not.toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("contractor add --self-onboarding blocks on missing email", async () => {
    const result = await run([
      "contractor",
      "add",
      "--type",
      "individual",
      "--first-name",
      "Jane",
      "--last-name",
      "Doe",
      "--wage-type",
      "fixed",
      "--start-date",
      "2026-01-01",
      "--self-onboarding",
    ]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("contractor add --type business blocks on missing business-name", async () => {
    const result = await run(["contractor", "add", "--type", "business", "--email", "billing@acme.example.com"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "business-name" }));
  });

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
  test("employee add personal-details --example", async () => {
    const result = await run(["employee", "add", "personal-details", "--example"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.method).toBe("POST");
    expect(envelope.data.path).toBe("/v1/companies/{company_uuid}/employees");
    expect(envelope.data.body.first_name).toBeTruthy();
    expect(envelope.data.body.email).toMatch(/@/);
  });

  test("contractor add --example defaults to individual", async () => {
    const result = await run(["contractor", "add", "--example"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.body.type).toBe("Individual");
  });

  test("contractor add --type business --example shows business shape", async () => {
    const result = await run(["contractor", "add", "--type", "business", "--example"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.body.type).toBe("Business");
    expect(envelope.data.body.business_name).toBeTruthy();
  });

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
});

describe("skill commands work without auth", () => {
  test("skill list shows bundled skills", async () => {
    const result = await run(["skill", "list"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.skills).toContainEqual(expect.objectContaining({ name: "onboard-company" }));
  });

  test("skill install onboard-company installs the bundled skill", async () => {
    const { mkdirSync, existsSync: exists, readFileSync, realpathSync } = await import("node:fs");
    const scratchRaw = mkdtempSync(path.join(tmpdir(), "gusto-cli-smoke-skill-"));
    const scratch = realpathSync(scratchRaw);
    try {
      const target = path.join(scratch, ".claude", "skills");
      mkdirSync(target, { recursive: true });
      const proc = Bun.spawn([BIN_PATH, "skill", "install", "onboard-company"], {
        cwd: scratch,
        stdout: "pipe",
        stderr: "pipe",
        env: stripGustoEnv(process.env),
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      const installed = path.join(target, "onboard-company", "SKILL.md");
      expect(exists(installed)).toBe(true);
      expect(readFileSync(installed, "utf8")).toContain("user-invocable: true");
      expect(JSON.parse(stdout.trim()).data.installedAt).toBe(installed);
    } finally {
      rmSync(scratchRaw, { recursive: true, force: true });
    }
  });
});

describe("--fields filters success output", () => {
  test("employee add --example --fields method,path keeps only those keys", async () => {
    const result = await run(["employee", "add", "personal-details", "--example", "--fields", "method,path"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(Object.keys(envelope.data)).toEqual(["method", "path"]);
  });

  test("employee add --fields (no value) rejects discovery on a write command, exit 2", async () => {
    // Bare `--fields` (discovery) is gated to read commands; it must not run a mutating handler
    // just to introspect output. `--example` doesn't change that — `employee add` is a write
    // command either way, so discovery is rejected before the handler runs.
    const result = await run(["employee", "add", "personal-details", "--example", "--fields"]);
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

// AINT-588: the inline `--token <value>` flag was dropped (it leaks secrets into
// ps/shell history/audit logs). Tokens now come from a stored session, the
// GUSTO_ACCESS_TOKEN env var, or `--token-stdin`.
describe("token-stdin authentication", () => {
  test("the removed --token <value> flag is rejected as an unknown option (exit 2)", async () => {
    const result = await run(["employee", "list", "--token", "abc"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown option");
  });

  test("help advertises --token-stdin and no longer mentions --token <token>", async () => {
    const result = await run(["employee", "add", "personal-details", "--help"]);
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
        "employee",
        "add",
        "personal-details",
        "--first-name",
        "Jane",
        "--last-name",
        "Doe",
        "--email",
        "j@example.com",
        "--token-stdin",
        "--dry-run",
      ],
      { GUSTO_COMPANY_UUID: "co-1" },
      "piped-secret-token\n",
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.path).toBe("/v1/companies/co-1/employees");
    expect(envelope.data.note).toBeUndefined();
  });

  test("without --token-stdin (and no session/env) the same dry-run reports token not required", async () => {
    // Mirror of the above with no token source: auth fails, so the dry-run falls back to
    // the placeholder path and the explanatory note - confirming stdin wasn't read.
    const result = await run(
      [
        "employee",
        "add",
        "personal-details",
        "--first-name",
        "Jane",
        "--last-name",
        "Doe",
        "--email",
        "j@example.com",
        "--dry-run",
      ],
      { GUSTO_COMPANY_UUID: "co-1" },
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.data.path).toBe("/v1/companies/{company_uuid}/employees");
    expect(envelope.data.note).toContain("token/company not required");
  });
});

describe("employee add: consistent missing employee_uuid contract", () => {
  // Omitting the positional employee_uuid must yield the same blocked_on validation
  // envelope (exit 7) across every subcommand - not a bare Commander error (exit 2).
  for (const sub of ["home-address", "work-address", "job", "federal-tax", "payment-method", "state-tax"]) {
    test(`${sub} without employee_uuid returns a validation envelope (exit 7)`, async () => {
      const result = await run(["employee", "add", sub]);
      expect(result.exitCode).toBe(7);
      const envelope = JSON.parse(result.stdout.trim());
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("validation");
      expect(envelope.error.blocked_on).toContainEqual({ field: "employee_uuid", reason: "required" });
    });

    test(`${sub} --help documents the employee_uuid positional`, async () => {
      const result = await run(["employee", "add", sub, "--help"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Arguments:");
      expect(result.stdout).toContain("employee_uuid");
    });
  }
});
