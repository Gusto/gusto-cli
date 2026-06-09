import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import type { GlobalFlags } from "../lib/global-flags.ts";
import { InputError } from "../lib/oauth/provision-input.ts";
import { companyProvisionHandler, provisionPayloadError, provisionResultData } from "./company.ts";

const globals: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };

describe("provisionResultData", () => {
  test("maps the claim url + company uuid from a company-scoped result", () => {
    expect(
      provisionResultData({
        accountClaimUrl: "https://claim/co-1",
        tokenInfo: { resource: { type: "Company", uuid: "co-1" } },
      }),
    ).toEqual({ account_claim_url: "https://claim/co-1", company_uuid: "co-1" });
  });

  test("company_uuid is null when the result token isn't company-scoped", () => {
    expect(
      provisionResultData({
        accountClaimUrl: "https://claim/x",
        tokenInfo: { resource: { type: "Employee", uuid: "e-1" } },
      }).company_uuid,
    ).toBeNull();
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
  test("dry-run returns the request shape without touching stdin", async () => {
    const result = await companyProvisionHandler({ example: true, dryRun: true })({
      command: "gusto company provision",
      globals,
    });
    expect(result.ok).toBe(true);
    expect((result as { data: { method: string; path: string } }).data.method).toBe("POST");
    expect((result as { data: { method: string; path: string } }).data.path).toBe("/v1/provision");
  });
});
