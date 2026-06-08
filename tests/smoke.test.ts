import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Run, spawnCapture } from "./support";

const BIN_PATH = path.resolve(import.meta.dir, "..", "dist", "gusto");

// Isolate the credential store so smoke runs never read the developer's real
// ~/.config/gusto (and so token-dependent commands stay deterministic).
const ISOLATED_CONFIG = mkdtempSync(path.join(tmpdir(), "gusto-cli-smoke-"));

async function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return spawnCapture([BIN_PATH, ...args], { ...stripGustoEnv(process.env), XDG_CONFIG_HOME: ISOLATED_CONFIG, ...env });
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

  test("ledger show with a non-positive --timeout blocks on timeout", async () => {
    const result = await run(["ledger", "show", "payroll-uuid-123", "--timeout", "0"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "timeout" }));
  });
});

describe("company provision input handling (offline)", () => {
  test("no --input/--example is a validation error", async () => {
    const result = await run(["company", "provision"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("invalid_input");
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
        // Week-based frequencies require it; harmless for the month-based ones.
        "--anchor-end-of-pay-period",
        "2026-06-26",
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

  test("employee add validates required args before auth", async () => {
    const result = await run(["employee", "add", "--first-name", "Jane"]);
    expect(result.exitCode).toBe(7);
    const envelope = JSON.parse(result.stdout.trim());
    expect(envelope.error.code).toBe("validation");
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "last-name" }));
    expect(envelope.error.blocked_on).toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("employee add with all required args + no token returns no_access_token", async () => {
    const result = await run(["employee", "add", "--first-name", "Jane", "--last-name", "Doe", "--email", "j@x.com"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout.trim()).error.code).toBe("no_access_token");
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
  test("employee add --example", async () => {
    const result = await run(["employee", "add", "--example"]);
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
});
