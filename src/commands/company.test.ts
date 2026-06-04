import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import { InputError } from "../lib/oauth/provision-input.ts";
import { provisionPayloadError, provisionResultData } from "./company.ts";

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
