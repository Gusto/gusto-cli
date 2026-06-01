import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient } from "./api-client.ts";
import { createCompanyResource, fetchResource, resolveApiContext } from "./api-context.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";

const flags: GlobalFlags = { agent: true, human: false, json: false, verbose: false };

// resolveApiContext reads token/company/base-url from process.env when no override is passed.
// Snapshot and clear the relevant vars so tests don't depend on the dev's shell.
const ENV_KEYS = ["GUSTO_ACCESS_TOKEN", "GUSTO_COMPANY_UUID", "GUSTO_API_BASE_URL", "GUSTO_API_VERSION"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveApiContext", () => {
  test("no token returns an auth-coded failure", () => {
    const result = resolveApiContext(flags, { requireCompany: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.result.ok).toBe(false);
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.exitCode).toBe(ExitCode.Auth);
    expect(result.result.error.code).toBe("no_access_token");
  });

  test("requireCompany:false skips the company check and returns an empty companyUuid", () => {
    const result = resolveApiContext(flags, { requireCompany: false, tokenOverride: "tok" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.companyUuid).toBe("");
    expect(result.ctx.client).toBeInstanceOf(ApiClient);
    expect(result.ctx.baseUrl).toBe("https://api.gusto-demo.com");
  });

  test("token present but company missing returns a validation failure", () => {
    const result = resolveApiContext(flags, { tokenOverride: "tok" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.exitCode).toBe(ExitCode.Validation);
    expect(result.result.error.code).toBe("no_company_uuid");
  });

  test("companyOverride passes through to the resolved context", () => {
    const result = resolveApiContext(flags, { tokenOverride: "tok", companyOverride: "co-123" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.companyUuid).toBe("co-123");
  });

  test("production env resolves the production base URL", () => {
    const result = resolveApiContext({ ...flags, env: "production" }, { requireCompany: false, tokenOverride: "tok" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.baseUrl).toBe("https://api.gusto.com");
  });
});

describe("createCompanyResource", () => {
  test("dry-run without auth emits the placeholder path and a note, never calls the API", async () => {
    const result = await createCompanyResource(flags, "employees", { first_name: "Jane" }, { dryRun: true });
    expect(result).toEqual({
      ok: true,
      data: {
        method: "POST",
        path: "/v1/companies/{company_uuid}/employees",
        body: { first_name: "Jane" },
        note: "dry-run: token/company not required",
      },
    });
  });

  test("dry-run with resolved context interpolates the company uuid and drops the note", async () => {
    const result = await createCompanyResource(
      flags,
      "contractors",
      { email: "a@b.com" },
      {
        token: "tok",
        companyUuid: "co-1",
        dryRun: true,
      },
    );
    expect(result).toEqual({
      ok: true,
      data: {
        method: "POST",
        path: "/v1/companies/co-1/contractors",
        body: { email: "a@b.com" },
      },
    });
  });

  test("non-dry-run without auth returns the context failure unchanged", async () => {
    const result = await createCompanyResource(flags, "employees", {}, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("no_access_token");
  });
});

describe("fetchResource", () => {
  test("returns the context failure and never builds a path when auth is missing", async () => {
    let built = false;
    const result = await fetchResource(flags, { requireCompany: false }, () => {
      built = true;
      return "/v1/token_info";
    });
    expect(built).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("no_access_token");
  });

  test("missing company surfaces a validation failure before the path builder runs", async () => {
    let built = false;
    const result = await fetchResource(flags, { tokenOverride: "tok" }, (ctx) => {
      built = true;
      return `/v1/companies/${ctx.companyUuid}/employees`;
    });
    expect(built).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.code).toBe("no_company_uuid");
  });
});
