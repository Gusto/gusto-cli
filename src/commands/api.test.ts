import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import { TEST_CONTEXT as ctx, okData as data, stubGlobalFetch } from "../lib/test-support.ts";
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

const PATH = "/v1/companies/co-1/federal_tax_details";

describe("api request --auto-version", () => {
  test("PUT GETs the current resource, injects its version, then PUTs", async () => {
    const { calls, restore } = stubGlobalFetch([
      { status: 200, body: { version: "v-current", ein: "00-0000000" } },
      { status: 200, body: { updated: true } },
    ]);
    try {
      const result = await apiRequestHandler("PUT", PATH, {
        autoVersion: true,
        confirm: true,
        data: '{"ein":"12-3456789"}',
      })(ctx);
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[1]?.method).toBe("PUT");
      expect(calls[1]?.body).toMatchObject({ ein: "12-3456789", version: "v-current" });
    } finally {
      restore();
    }
  });

  test("PATCH auto-versions the same way as PUT", async () => {
    const { calls, restore } = stubGlobalFetch([
      { status: 200, body: { version: "v-current" } },
      { status: 200, body: { updated: true } },
    ]);
    try {
      const result = await apiRequestHandler("PATCH", PATH, { autoVersion: true, confirm: true, data: '{"x":1}' })(ctx);
      expect(result.ok).toBe(true);
      expect(calls[0]?.method).toBe("GET");
      expect(calls[1]?.method).toBe("PATCH");
      expect(calls[1]?.body).toMatchObject({ x: 1, version: "v-current" });
    } finally {
      restore();
    }
  });

  test("a caller-supplied version wins and skips the GET", async () => {
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: { updated: true } }]);
    try {
      const result = await apiRequestHandler("PUT", PATH, {
        autoVersion: true,
        confirm: true,
        data: '{"ein":"12-3456789","version":"caller-set"}',
      })(ctx);
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("PUT");
      expect(calls[0]?.body).toMatchObject({ version: "caller-set" });
    } finally {
      restore();
    }
  });

  test("an empty/invalid caller version does not clobber the fetched one", async () => {
    // "" is rejected by the version check, so the GET still fires - but the fetched
    // version must win, not the caller's empty string (regression: spread order).
    const { calls, restore } = stubGlobalFetch([
      { status: 200, body: { version: "v-current" } },
      { status: 200, body: { updated: true } },
    ]);
    try {
      const result = await apiRequestHandler("PUT", PATH, {
        autoVersion: true,
        confirm: true,
        data: '{"ein":"9","version":""}',
      })(ctx);
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.method).toBe("PUT");
      expect(calls[1]?.body).toMatchObject({ ein: "9", version: "v-current" });
    } finally {
      restore();
    }
  });

  test("a body with no version uses just the fetched version (PUT with no --data)", async () => {
    const { calls, restore } = stubGlobalFetch([
      { status: 200, body: { version: "v-current" } },
      { status: 200, body: { updated: true } },
    ]);
    try {
      const result = await apiRequestHandler("PUT", PATH, { autoVersion: true, confirm: true })(ctx);
      expect(result.ok).toBe(true);
      expect(calls[1]?.body).toEqual({ version: "v-current" });
    } finally {
      restore();
    }
  });

  test("--auto-version on a non-PUT/PATCH method is a validation error", async () => {
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: {} }]);
    try {
      const result = await apiRequestHandler("GET", PATH, { autoVersion: true, confirm: true })(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("auto_version_unsupported");
      expect(result.exitCode).toBe(ExitCode.Validation);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("when the GET response has no top-level version, it errors without sending the write", async () => {
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: { no_version_here: true } }]);
    try {
      const result = await apiRequestHandler("PUT", PATH, { autoVersion: true, confirm: true, data: '{"x":1}' })(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("version_unresolved");
      expect(result.exitCode).toBe(ExitCode.Validation);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("GET");
    } finally {
      restore();
    }
  });

  test("a failing version GET surfaces a clean API error, not an unhandled throw", async () => {
    // The version GET runs before the write; its failure must route through toResult
    // (api_client_error envelope), not escape send() and bubble up as internal_error.
    const { calls, restore } = stubGlobalFetch([{ status: 404, body: { error: "not found" } }]);
    try {
      const result = await apiRequestHandler("PUT", PATH, { autoVersion: true, confirm: true, data: '{"x":1}' })(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("api_client_error");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("GET");
    } finally {
      restore();
    }
  });

  test("--auto-version with a non-object body is rejected (can't inject version)", async () => {
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: {} }]);
    try {
      const result = await apiRequestHandler("PUT", PATH, { autoVersion: true, confirm: true, data: "[1,2,3]" })(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("auto_version_requires_object");
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("--auto-version with an explicit null body is rejected (typeof null is 'object')", async () => {
    // Regression: `--data null` slipped past the shape check because typeof null === "object", then
    // (body ?? {}) silently coerced it to {} and the write went out instead of being rejected.
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: {} }]);
    try {
      const result = await apiRequestHandler("PUT", PATH, { autoVersion: true, confirm: true, data: "null" })(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("auto_version_requires_object");
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("auto-version resolves the {company_uuid} placeholder before the version GET/PUT", async () => {
    const { calls, restore } = stubGlobalFetch([
      { status: 200, body: { version: "v-current" } },
      { status: 200, body: { updated: true } },
    ]);
    try {
      const result = await apiRequestHandler("PUT", "/v1/companies/{company_uuid}/federal_tax_details", {
        autoVersion: true,
        confirm: true,
        companyUuid: "co-9",
        data: '{"x":1}',
      })(ctx);
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.url).toContain("/v1/companies/co-9/federal_tax_details");
      expect(calls[0]?.url).not.toContain("{company_uuid}");
      expect(calls[1]?.body).toMatchObject({ x: 1, version: "v-current" });
    } finally {
      restore();
    }
  });

  test("--dry-run --auto-version shows the body without version and notes it (no network)", async () => {
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: {} }]);
    try {
      const d = data(
        await apiRequestHandler("PUT", PATH, { autoVersion: true, data: '{"ein":"12-3"}', dryRun: true })(ctx),
      );
      expect(d.method).toBe("PUT");
      expect(d.body).toEqual({ ein: "12-3" });
      expect(d.note).toMatch(/version.*send time/i);
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("--dry-run without --auto-version is unchanged (no note)", async () => {
    const d = data(await apiRequestHandler("PUT", PATH, { data: '{"ein":"12-3"}', dryRun: true })(ctx));
    expect(d.body).toEqual({ ein: "12-3" });
    expect(d.note).toBeUndefined();
  });

  test("--dry-run --auto-version with a non-object body is rejected (same as a real send)", async () => {
    // The body-shape check needs no network, so a dry-run surfaces it too - the user finds out
    // before sending rather than getting an ok dry-run that a real send would then reject.
    const { calls, restore } = stubGlobalFetch([{ status: 200, body: {} }]);
    try {
      const result = await apiRequestHandler("PUT", PATH, { autoVersion: true, data: "[1,2,3]", dryRun: true })(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("auto_version_requires_object");
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });
});

describe("api request write confirmation gate", () => {
  test("an agent-mode write without --confirm is blocked and sends nothing", async () => {
    const { calls, restore } = stubGlobalFetch(() => ({ status: 500 }));
    try {
      const result = await apiRequestHandler("POST", "/v1/companies/{company_uuid}/employees", {
        data: '{"first_name":"Jane"}',
      })(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.exitCode).toBe(ExitCode.Blocked);
      expect(result.error.code).toBe("confirmation_required");
      expect(calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("a GET is never gated", async () => {
    const { restore } = stubGlobalFetch([{ status: 200, body: { ok: true } }]);
    try {
      const result = await apiRequestHandler("GET", "/v1/me", {})(ctx);
      expect(result.ok).toBe(true);
    } finally {
      restore();
    }
  });

  test("--confirm lets the write POST", async () => {
    const { calls, restore } = stubGlobalFetch((u) =>
      u.includes("/employees") ? { status: 201, body: { uuid: "ee-1" } } : { status: 404 },
    );
    try {
      const result = await apiRequestHandler("POST", "/v1/companies/co-1/employees", {
        confirm: true,
        data: '{"first_name":"Jane"}',
      })(ctx);
      expect(result.ok).toBe(true);
      expect(calls.find((c) => c.method === "POST")?.url).toContain("/employees");
    } finally {
      restore();
    }
  });
});
