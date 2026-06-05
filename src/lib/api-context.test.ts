import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient } from "./api-client.ts";
import { createCompanyResource, fetchCompanyResource, fetchResource, resolveApiContext } from "./api-context.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { OAuthError } from "./oauth/endpoints.ts";
import { memoryStore, mockHttp } from "./oauth/test-support.ts";
import type { TokenStore } from "./oauth/token-store.ts";

const flags: GlobalFlags = { agent: true, human: false, json: false, verbose: false };

// An empty store + harmless http so token/company resolution can't fall back to
// the real on-disk session. Tests that exercise the session path pass their own.
const noSession = () => ({ store: memoryStore(), http: mockHttp({ status: 200 }) });

// A store whose load() rejects, to drive resolveToken's error handling.
const throwingStore = (err: unknown): TokenStore => ({
  load: () => Promise.reject(err),
  save: () => Promise.resolve(),
  clear: () => Promise.resolve(),
});

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
  test("no token (no override, env, or session) returns an auth-coded failure", async () => {
    const result = await resolveApiContext(flags, { requireCompany: false, ...noSession() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.exitCode).toBe(ExitCode.Auth);
    expect(result.result.error.code).toBe("no_access_token");
  });

  test("requireCompany:false returns a context narrowed to hasCompany:false", async () => {
    const result = await resolveApiContext(flags, { requireCompany: false, tokenOverride: "tok" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.hasCompany).toBe(false);
    expect(result.ctx.client).toBeInstanceOf(ApiClient);
    expect(result.ctx.baseUrl).toBe("https://api.gusto-demo.com");
  });

  test("token present but company missing returns a validation failure", async () => {
    const result = await resolveApiContext(flags, { tokenOverride: "tok", ...noSession() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.exitCode).toBe(ExitCode.Validation);
    expect(result.result.error.code).toBe("no_company_uuid");
  });

  test("companyOverride passes through to the resolved context", async () => {
    const result = await resolveApiContext(flags, { tokenOverride: "tok", companyOverride: "co-123" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.hasCompany).toBe(true);
    expect(result.ctx.companyUuid).toBe("co-123");
  });

  test("production env resolves the production base URL", async () => {
    const result = await resolveApiContext(
      { ...flags, env: "production" },
      { requireCompany: false, tokenOverride: "tok" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.baseUrl).toBe("https://api.gusto.com");
  });
});

describe("resolveApiContext - stored session fallback", () => {
  test("falls back to the stored session token when no override/env", async () => {
    const store = memoryStore({ sandbox: { accessToken: "sess-tok", expiresAt: 10_000_000 } });
    const result = await resolveApiContext(flags, {
      requireCompany: false,
      store,
      http: mockHttp({ status: 200 }),
      now: () => 1_000,
    });
    expect(result.ok).toBe(true);
  });

  test("a failed token refresh (OAuthError) degrades to no_access_token", async () => {
    const result = await resolveApiContext(flags, {
      requireCompany: false,
      store: throwingStore(new OAuthError(400, { error: "invalid_grant" }, "refresh failed")),
      http: mockHttp({ status: 200 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.error.code).toBe("no_access_token");
  });

  test("an unexpected session error (e.g. unreadable file) is not swallowed", async () => {
    await expect(
      resolveApiContext(flags, {
        requireCompany: false,
        store: throwingStore(new Error("EACCES: permission denied")),
        http: mockHttp({ status: 200 }),
      }),
    ).rejects.toThrow("EACCES");
  });

  test("falls back to the stored companyUuid when no --company-uuid/env", async () => {
    const store = memoryStore({ sandbox: { accessToken: "sess-tok", expiresAt: 10_000_000, companyUuid: "co-sess" } });
    const result = await resolveApiContext(flags, { store, http: mockHttp({ status: 200 }), now: () => 1_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.companyUuid).toBe("co-sess");
  });

  test("--company-uuid wins over the stored companyUuid", async () => {
    const store = memoryStore({ sandbox: { accessToken: "sess-tok", expiresAt: 10_000_000, companyUuid: "co-sess" } });
    const result = await resolveApiContext(flags, {
      companyOverride: "co-flag",
      store,
      http: mockHttp({ status: 200 }),
      now: () => 1_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.companyUuid).toBe("co-flag");
  });

  test("env/override token wins over the session - the session is never touched", async () => {
    process.env.GUSTO_ACCESS_TOKEN = "env-tok";
    // Near-expiry session whose refresh would throw if consulted.
    const store = memoryStore({
      sandbox: { clientId: "c", clientSecret: "s", accessToken: "old", refreshToken: "rt", expiresAt: 2_000 },
    });
    const result = await resolveApiContext(flags, {
      requireCompany: false,
      store,
      http: mockHttp({ status: 500 }),
      now: () => 1_990,
    });
    expect(result.ok).toBe(true);
    expect(store.data.sandbox?.accessToken).toBe("old"); // not refreshed
  });
});

describe("createCompanyResource", () => {
  test("dry-run without auth emits the placeholder path and a note, never calls the API", async () => {
    const result = await createCompanyResource(
      flags,
      "employees",
      { first_name: "Jane" },
      { dryRun: true, ...noSession() },
    );
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
      { token: "tok", companyUuid: "co-1", dryRun: true },
    );
    expect(result).toEqual({
      ok: true,
      data: { method: "POST", path: "/v1/companies/co-1/contractors", body: { email: "a@b.com" } },
    });
  });

  test("non-dry-run without auth returns the context failure unchanged", async () => {
    const result = await createCompanyResource(flags, "employees", {}, noSession());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("no_access_token");
  });
});

describe("fetchResource", () => {
  test("returns the context failure and never builds a path when auth is missing", async () => {
    let built = false;
    const result = await fetchResource(flags, noSession(), () => {
      built = true;
      return "/v1/token_info";
    });
    expect(built).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("no_access_token");
  });
});

describe("fetchCompanyResource", () => {
  test("missing company surfaces a validation failure before the path builder runs", async () => {
    let built = false;
    const result = await fetchCompanyResource(flags, { token: "tok", ...noSession() }, (ctx) => {
      built = true;
      return `/v1/companies/${ctx.companyUuid}/employees`;
    });
    expect(built).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.code).toBe("no_company_uuid");
  });

  test("missing token surfaces an auth failure before the path builder runs", async () => {
    let built = false;
    const result = await fetchCompanyResource(flags, noSession(), (ctx) => {
      built = true;
      return `/v1/companies/${ctx.companyUuid}/employees`;
    });
    expect(built).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
  });
});
