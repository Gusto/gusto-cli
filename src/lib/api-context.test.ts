import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiClient, ApiError } from "./api-client.ts";
import {
  createCompanyResource,
  fetchCompanyResource,
  fetchResource,
  putCompanyResource,
  resolveApiContext,
  resolveAuthToken,
  withCompanyContext,
} from "./api-context.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { OAuthError } from "./oauth/endpoints.ts";
import { memoryStore, mockHttp } from "./oauth/test-support.ts";
import type { TokenStore } from "./oauth/token-store.ts";

const flags: GlobalFlags = { agent: true, human: false, json: false, verbose: false };

// An empty store + harmless http so token/company resolution can't fall back to
// the real on-disk session. Tests that exercise the session path pass their own.
const noSession = () => ({ store: memoryStore(), http: mockHttp({ status: 200 }) });

// Authenticate via the lowest-priority rung: a token piped on --token-stdin, with
// no stored session and (by default) no env var. The injected readStdin stands in
// for real stdin. Used wherever a test just needs *a* token to get past auth.
const stdinAuth = (tok: string | null = "tok") => ({
  ...noSession(),
  tokenStdin: true,
  readStdin: () => Promise.resolve(tok),
});

// A reader that fails the test if stdin is ever consumed - proves laziness when a
// higher-priority source (session/env) should win before stdin is touched.
const forbiddenStdin = () => Promise.reject(new Error("stdin must not be read"));

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
  test("no token (no session, env, or stdin) returns an auth-coded failure", async () => {
    const result = await resolveApiContext(flags, { requireCompany: false, ...noSession() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.exitCode).toBe(ExitCode.Auth);
    expect(result.result.error.code).toBe("no_access_token");
    expect(result.result.error.message).toContain("--token-stdin");
  });

  test("requireCompany:false returns a context narrowed to hasCompany:false", async () => {
    const result = await resolveApiContext(flags, { requireCompany: false, ...stdinAuth() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.hasCompany).toBe(false);
    expect(result.ctx.client).toBeInstanceOf(ApiClient);
    expect(result.ctx.baseUrl).toBe("https://api.gusto-demo.com");
  });

  test("token present but company missing returns a validation failure", async () => {
    const result = await resolveApiContext(flags, { ...stdinAuth() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.exitCode).toBe(ExitCode.Validation);
    expect(result.result.error.code).toBe("no_company_uuid");
  });

  test("companyOverride passes through to the resolved context", async () => {
    const result = await resolveApiContext(flags, { ...stdinAuth(), companyOverride: "co-123" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.hasCompany).toBe(true);
    expect(result.ctx.companyUuid).toBe("co-123");
  });

  test("production env resolves the production base URL", async () => {
    const result = await resolveApiContext({ ...flags, env: "production" }, { requireCompany: false, ...stdinAuth() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.baseUrl).toBe("https://api.gusto.com");
  });

  test("the resolved context exposes which credential source won", async () => {
    const result = await resolveApiContext(flags, { requireCompany: false, ...stdinAuth() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.tokenSource).toBe("stdin");
  });
});

describe("resolveAuthToken - explicit token precedence (stdin > env > session)", () => {
  test("--token-stdin wins over env and a stored session", async () => {
    process.env.GUSTO_ACCESS_TOKEN = "env-tok";
    const store = memoryStore({ sandbox: { accessToken: "sess-tok", expiresAt: 10_000_000 } });
    const resolved = await resolveAuthToken(flags, {
      store,
      http: mockHttp({ status: 200 }),
      now: () => 1_000,
      tokenStdin: true,
      readStdin: () => Promise.resolve("stdin-tok"),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.token).toBe("stdin-tok");
    expect(resolved.source).toBe("stdin");
  });

  test("GUSTO_ACCESS_TOKEN wins over a stored session; the session is never resolved", async () => {
    process.env.GUSTO_ACCESS_TOKEN = "env-tok";
    const resolved = await resolveAuthToken(flags, {
      store: throwingStore(new Error("session must not be loaded when env token is set")),
      http: mockHttp({ status: 200 }),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.token).toBe("env-tok");
    expect(resolved.source).toBe("env");
  });

  test("the stored session is used only when no explicit token is supplied", async () => {
    const store = memoryStore({ sandbox: { accessToken: "sess-tok", expiresAt: 10_000_000 } });
    const resolved = await resolveAuthToken(flags, {
      store,
      http: mockHttp({ status: 200 }),
      now: () => 1_000,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.token).toBe("sess-tok");
    expect(resolved.source).toBe("session");
  });

  test("an env token is used even when a session exists - it is never replaced by the session", async () => {
    // A bad explicit token surfaces the real auth error; it does not silently run
    // as the session's identity. Assert the env value is the resolved token even
    // though a valid session is present.
    process.env.GUSTO_ACCESS_TOKEN = "bad-explicit-tok";
    const store = memoryStore({ sandbox: { accessToken: "sess-tok", expiresAt: 10_000_000 } });
    const resolved = await resolveAuthToken(flags, { store, http: mockHttp({ status: 200 }), now: () => 1_000 });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.token).toBe("bad-explicit-tok");
    expect(resolved.source).toBe("env");
  });

  test("--token-stdin with nothing piped fails closed instead of falling back to env or session", async () => {
    // The user opted into an explicit credential source; an empty pipe is the same
    // silent-identity-drift hazard as a bad env token. Even with env + session set,
    // we must not silently run as one of them.
    process.env.GUSTO_ACCESS_TOKEN = "env-tok";
    const store = memoryStore({ sandbox: { accessToken: "sess-tok", expiresAt: 10_000_000 } });
    const resolved = await resolveAuthToken(flags, {
      tokenStdin: true,
      readStdin: () => Promise.resolve(null),
      store,
      http: mockHttp({ status: 200 }),
      now: () => 1_000,
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    if (resolved.result.ok) throw new Error("unreachable");
    expect(resolved.result.error.code).toBe("no_access_token");
    expect(resolved.result.error.message).toContain("--token-stdin");
  });

  test("--token-stdin with nothing piped fails closed when env and session are also absent", async () => {
    const resolved = await resolveAuthToken(flags, { ...stdinAuth(null) });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    if (resolved.result.ok) throw new Error("unreachable");
    expect(resolved.result.error.code).toBe("no_access_token");
  });

  test("stdin is not read unless --token-stdin was passed", async () => {
    const resolved = await resolveAuthToken(flags, {
      ...noSession(),
      readStdin: forbiddenStdin, // present but tokenStdin is falsy, so never invoked
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    if (resolved.result.ok) throw new Error("unreachable");
    expect(resolved.result.error.code).toBe("no_access_token");
  });
});

describe("resolveApiContext - company fallback honors the resolved token source", () => {
  test("an env token never borrows the session's company", async () => {
    process.env.GUSTO_ACCESS_TOKEN = "env-tok";
    const store = memoryStore({ sandbox: { accessToken: "sess-tok", expiresAt: 10_000_000, companyUuid: "co-sess" } });
    const result = await resolveApiContext(flags, { store, http: mockHttp({ status: 200 }), now: () => 1_000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.error.code).toBe("no_company_uuid");
  });
});

describe("resolveApiContext - stored session fallback", () => {
  test("falls back to the stored session token when no env/stdin", async () => {
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

  test("a stdin token does not borrow a company (none to borrow without a session)", async () => {
    const result = await resolveApiContext(flags, { ...stdinAuth("piped-tok") });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    if (result.result.ok) throw new Error("unreachable");
    expect(result.result.error.code).toBe("no_company_uuid");
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
      {
        ...stdinAuth(),
        companyUuid: "co-1",
        dryRun: true,
      },
    );
    expect(result).toEqual({
      ok: true,
      data: { method: "POST", path: "/v1/companies/co-1/contractors", body: { email: "a@b.com" } },
    });
  });

  test("non-dry-run without auth returns the context failure unchanged", async () => {
    // confirm:true gets past the agent-mode write gate so this exercises auth passthrough.
    const result = await createCompanyResource(flags, "employees", {}, { ...noSession(), confirm: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
    expect(result.error.code).toBe("no_access_token");
  });
});

describe("company-resource write confirmation gate", () => {
  test("an agent-mode write without --confirm is blocked before auth/company resolution", async () => {
    // noSession() supplies no token, so without the gate this would fail with an auth error.
    // The gate fires first, so the agent learns it must confirm before anything else.
    const result = await createCompanyResource(flags, "pay_schedules", { frequency: "Monthly" }, noSession());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("confirmation_required");
  });

  test("--confirm lets the write proceed past the gate to auth resolution", async () => {
    const result = await createCompanyResource(flags, "pay_schedules", {}, { ...noSession(), confirm: true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
  });

  test("putCompanyResource is gated the same way", async () => {
    const result = await putCompanyResource(flags, "payrolls/pay-1/prepare", undefined, noSession());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("confirmation_required");
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
    const result = await fetchCompanyResource(flags, { ...stdinAuth() }, (ctx) => {
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

describe("withCompanyContext", () => {
  test("auth failure short-circuits before fn runs", async () => {
    let ran = false;
    const result = await withCompanyContext(flags, noSession(), async () => {
      ran = true;
      return { ok: true, data: undefined };
    });
    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth);
  });

  test("maps an ApiError thrown by fn via toResult", async () => {
    const result = await withCompanyContext(flags, { ...stdinAuth(), companyUuid: "co-1" }, async () => {
      throw new ApiError(404, { error: "nope" }, ExitCode.ApiClient, "GET x -> 404");
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
    expect(result.error.code).toBe("api_client_error");
  });

  test("returns fn's result on success", async () => {
    const result = await withCompanyContext(flags, { ...stdinAuth(), companyUuid: "co-1" }, async (ctx) => ({
      ok: true,
      data: { company: ctx.companyUuid },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as { company: string }).company).toBe("co-1");
  });
});
