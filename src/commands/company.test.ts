import { afterEach, describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import type { GlobalFlags } from "../lib/global-flags.ts";
import { InputError } from "../lib/oauth/provision-input.ts";
import { TEST_CONTEXT as ctx, stubGlobalFetch } from "../lib/test-support.ts";
import {
  type CompanyShowData,
  companyProvisionHandler,
  provisionPayloadError,
  provisionResultData,
  renderCompanyShow,
} from "./company.ts";

const globals: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };

function showData(overrides: Partial<CompanyShowData> = {}): CompanyShowData {
  const { success, partial_errors, ...rest } = overrides;
  const base = {
    company_uuid: "co-1",
    summary: {
      name: "Acme Inc",
      trade_name: "Acme",
      status: "approved",
      tier: "plus",
      ein: "12-3456789",
      entity_type: "LLC",
      payment_speed: "2-day",
      pay_schedule: { frequency: "every_other_week", anchor_pay_date: "2026-01-15" },
    },
    company: null,
    payment_config: null,
    pay_schedules: [{ uuid: "ps-1", frequency: "every_other_week", anchor_pay_date: "2026-01-15" }],
    ...rest,
  };
  return success === false
    ? { ...base, success: false, partial_errors: partial_errors ?? [] }
    : { ...base, success: true };
}

describe("renderCompanyShow", () => {
  test("renders a key-value overview, not JSON", () => {
    const out = renderCompanyShow(showData());
    expect(out).not.toContain("{");
    expect(out).toContain("Acme Inc");
    expect(out).toContain("co-1");
    expect(out).toContain("approved");
    expect(out).toContain("12-3456789");
  });

  test("renders pay schedules as a table", () => {
    const out = renderCompanyShow(showData());
    expect(out).toContain("Pay schedules");
    expect(out).toContain("ps-1");
    expect(out).toContain("every_other_week");
    expect(out).toContain("2026-01-15");
  });

  test("omits missing summary fields but always shows the UUID", () => {
    const out = renderCompanyShow(
      showData({
        summary: {
          name: null,
          trade_name: null,
          status: null,
          tier: null,
          ein: null,
          entity_type: null,
          payment_speed: null,
          pay_schedule: null,
        },
        pay_schedules: null,
      }),
    );
    expect(out).toContain("UUID  co-1");
    expect(out).not.toContain("Status");
    expect(out).not.toContain("EIN");
  });

  test("omits the pay-schedules table when there are none", () => {
    expect(renderCompanyShow(showData({ pay_schedules: [] }))).not.toContain("Pay schedules");
    expect(renderCompanyShow(showData({ pay_schedules: null }))).not.toContain("Pay schedules");
  });

  test("surfaces partial_errors as a warning block", () => {
    const out = renderCompanyShow(
      showData({ success: false, partial_errors: [{ label: "payment_config", error: "404 not found" }] }),
    );
    expect(out).toContain("payment_config");
    expect(out).toContain("404 not found");
  });
});

describe("provisionResultData", () => {
  test("returns the claim url and points at `auth login` as the next step", () => {
    expect(provisionResultData({ accountClaimUrl: "https://claim/co-1" })).toEqual({
      account_claim_url: "https://claim/co-1",
      next_command: "gusto auth login",
      next_step: "Claim the account in your browser, then run `gusto auth login` to authenticate.",
    });
  });
});

describe("provisionPayloadError", () => {
  test("maps an InputError to a validation result", () => {
    expect(provisionPayloadError(new InputError("bad payload"))).toEqual({
      ok: false,
      exitCode: ExitCode.Validation,
      error: { code: "invalid_input", message: "bad payload" },
    });
  });

  test("routes a non-InputError through toResult", () => {
    const result = provisionPayloadError(new Error("boom"));
    expect(result.ok).toBe(false);
  });
});

describe("companyProvisionHandler", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  test("--example returns a canned payload and does not hit the network", async () => {
    let called = false;
    restore = stubGlobalFetch(() => {
      called = true;
      return { status: 500 };
    }).restore;
    const result = await companyProvisionHandler({ example: true })({
      ...ctx,
      command: "gusto company provision",
      globals,
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    const data = (result as { data: { method: string; path: string; body: { user: { email: string } }; note: string } })
      .data;
    expect(data.method).toBe("POST");
    expect(data.path).toBe("/v1/provision");
    expect(data.body.user.email).toMatch(/^ada\+[0-9a-f]+@example\.com$/);
    expect(data.note).toContain("example");
  });

  test("--dry-run with --input returns the request shape without touching the network or hitting the example branch", async () => {
    const inputPath = `/tmp/gusto-cli-provision-${process.pid}-${Date.now()}.json`;
    await Bun.write(
      inputPath,
      JSON.stringify({
        user: { email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" },
        company: { name: "Analytical Engines", ein: "12-3456789", trade_name: "AE" },
      }),
    );
    let called = false;
    restore = stubGlobalFetch(() => {
      called = true;
      return { status: 500 };
    }).restore;
    const result = await companyProvisionHandler({ input: inputPath, dryRun: true })({
      ...ctx,
      command: "gusto company provision",
      globals,
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    const data = (result as { data: { method: string; path: string; note?: string } }).data;
    expect(data.method).toBe("POST");
    expect(data.path).toBe("/v1/provision");
    // Distinguishes dry-run from example: the example branch attaches a `note`, dry-run does not.
    expect(data.note).toBeUndefined();
  });

  test("bare invocation returns the standard missing-args envelope with blocked_on", async () => {
    const result = await companyProvisionHandler({})({
      ...ctx,
      command: "gusto company provision",
      globals,
    });
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.Validation,
      error: {
        code: "validation",
        message: "missing required arguments",
        blocked_on: [
          {
            field: "input",
            reason: "provide --input <file.json> with a {user, company} payload, or --example for a sample run",
          },
        ],
      },
    });
  });

  test("an unreadable --input still returns the invalid_input shape (not blocked_on)", async () => {
    const result = await companyProvisionHandler({ input: "/does/not/exist.json" })({
      ...ctx,
      command: "gusto company provision",
      globals,
    });
    expect(result.ok).toBe(false);
    const err = result as { ok: false; exitCode: number; error: { code: string; message: string } };
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(err.error.code).toBe("invalid_input");
    expect(err.error.message).toContain("/does/not/exist.json");
  });
});
