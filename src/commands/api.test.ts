import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import { stubGlobalFetch } from "../lib/test-support.ts";
import { TEST_CONTEXT as ctx, okData as data } from "../lib/test-support.ts";
import { apiRequestHandler } from "./api.ts";

describe("api request {company_uuid} substitution", () => {
  test("dry-run substitutes the bound company UUID into the path", async () => {
    const d = data(
      await apiRequestHandler("GET", "/v1/companies/{company_uuid}/employees", {
        dryRun: true,
        companyUuid: "co-1",
      })(ctx),
    );
    expect(d.method).toBe("GET");
    expect(d.path).toBe("/v1/companies/co-1/employees");
  });

  test("dry-run substitutes every occurrence of the placeholder", async () => {
    const d = data(
      await apiRequestHandler("GET", "/v1/companies/{company_uuid}/x/{company_uuid}", {
        dryRun: true,
        companyUuid: "co-1",
      })(ctx),
    );
    expect(d.path).toBe("/v1/companies/co-1/x/co-1");
  });

  test("a real request sends to the substituted path", async () => {
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: { ok: true } }]);
    try {
      const result = await apiRequestHandler("GET", "/v1/companies/{company_uuid}/employees", {
        companyUuid: "co-1",
      })(ctx);
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("/v1/companies/co-1/employees");
      expect(calls[0]?.url).not.toContain("{company_uuid}");
    } finally {
      restore();
    }
  });

  test("a path with the placeholder but no resolvable company fails with no_company_uuid", async () => {
    // preload supplies a token (env) but no GUSTO_COMPANY_UUID, and none is passed.
    const result = await apiRequestHandler("GET", "/v1/companies/{company_uuid}/employees", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("no_company_uuid");
    expect(result.exitCode).toBe(ExitCode.Validation);
  });

  test("dry-run with the placeholder but no company keeps the placeholder and notes it", async () => {
    const d = data(await apiRequestHandler("GET", "/v1/companies/{company_uuid}/employees", { dryRun: true })(ctx));
    expect(d.path).toBe("/v1/companies/{company_uuid}/employees");
    expect(d.note).toBeTruthy();
  });
});

describe("api request without the placeholder is unchanged", () => {
  test("dry-run passes a plain path through untouched, no company needed", async () => {
    const d = data(await apiRequestHandler("GET", "/v1/me", { dryRun: true })(ctx));
    expect(d.path).toBe("/v1/me");
    expect(d.note).toBeUndefined();
  });

  test("a real request to a company-less path works without a company UUID", async () => {
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: { email: "a@b.com" } }]);
    try {
      const result = await apiRequestHandler("GET", "/v1/me", {})(ctx);
      expect(result.ok).toBe(true);
      expect(calls[0]?.url).toContain("/v1/me");
    } finally {
      restore();
    }
  });
});

describe("api request --company-uuid on a path with no placeholder", () => {
  test("warns that the flag was ignored", async () => {
    const warnings: string[] = [];
    const d = data(
      await apiRequestHandler("GET", "/v1/me", { companyUuid: "co-1", dryRun: true }, (m) => warnings.push(m))(ctx),
    );
    expect(d.path).toBe("/v1/me");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/--company-uuid/);
    expect(warnings[0]).toMatch(/\{company_uuid\}/);
  });

  test("does not warn when --company-uuid is absent", async () => {
    const warnings: string[] = [];
    await apiRequestHandler("GET", "/v1/me", { dryRun: true }, (m) => warnings.push(m))(ctx);
    expect(warnings).toHaveLength(0);
  });

  test("does not warn when the path uses the placeholder (the flag is used)", async () => {
    const warnings: string[] = [];
    await apiRequestHandler(
      "GET",
      "/v1/companies/{company_uuid}/employees",
      { companyUuid: "co-1", dryRun: true },
      (m) => warnings.push(m),
    )(ctx);
    expect(warnings).toHaveLength(0);
  });
});
