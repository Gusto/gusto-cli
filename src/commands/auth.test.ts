import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GlobalFlags } from "../lib/global-flags.ts";
import { TEST_CONTEXT as ctx, TEST_GLOBALS, captureSinks, stubGlobalFetch } from "../lib/test-support.ts";
import { memoryStore } from "../lib/oauth/test-support.ts";
import {
  CREDENTIAL_SOURCE_LABEL,
  authLoginHandler,
  authWhoamiHandler,
  buildSignInUrlEmitter,
  loginResultData,
  performLogout,
} from "./auth.ts";

// whoami's token resolution (explicit token first: --token-stdin > env > session)
// is covered by api-context.test.ts; the cases below cover the capabilities
// summary and credential-source label it layers on top.

describe("loginResultData", () => {
  test("maps token_info to identity + company_uuid + scope", () => {
    expect(
      loginResultData({
        scope: "public",
        resource: { type: "Company", uuid: "co-1" },
        resource_owner: { type: "CompanyAdmin", uuid: "u-1" },
      }),
    ).toEqual({ identity: { type: "CompanyAdmin", uuid: "u-1" }, company_uuid: "co-1", scope: "public" });
  });

  test("company_uuid is null when the token is not company-scoped", () => {
    expect(
      loginResultData({
        resource: { type: "Employee", uuid: "e-1" },
        resource_owner: { type: "Employee", uuid: "e-1" },
      }).company_uuid,
    ).toBeNull();
  });

  test("throws when token_info carries no identity", () => {
    expect(() => loginResultData({ resource: { type: "Company", uuid: "co-1" } })).toThrow(/no identity/);
  });
});

describe("performLogout", () => {
  test("no stored session -> cleared:false", async () => {
    expect(await performLogout(memoryStore(), "sandbox")).toEqual({ cleared: false });
  });

  test("clears the stored session and reports cleared:true", async () => {
    const store = memoryStore({ sandbox: { clientId: "c", clientSecret: "s", accessToken: "at" } });
    expect(await performLogout(store, "sandbox")).toEqual({ cleared: true });
    expect(store.data.sandbox).toBeUndefined();
  });
});

describe("buildSignInUrlEmitter", () => {
  const human: GlobalFlags = { ...TEST_GLOBALS, agent: false, human: true, json: false };

  test("returns undefined in human mode", () => {
    const { sinks } = captureSinks();
    expect(buildSignInUrlEmitter(human, sinks)).toBeUndefined();
  });

  test("explicit --agent writes a newline-terminated JSON line to stdout", () => {
    const { sinks, stdout } = captureSinks();
    const emit = buildSignInUrlEmitter({ ...human, agent: true, human: false }, sinks);
    expect(emit).toBeDefined();
    emit?.({ event: "sign_in_url", sign_in_url: "https://auth.test/x", state: "s1" });
    expect(stdout.buffer).toBe(
      `${JSON.stringify({ event: "sign_in_url", sign_in_url: "https://auth.test/x", state: "s1" })}\n`,
    );
  });

  // Auto-on agent mode (piped stdout) is what makes the AINT-644 event reachable
  // for harnesses that don't pass --agent explicitly. The flags carry agent=false
  // and human=false; resolveOutputMode reads the TTY to decide. Stub the TTY check
  // via the writable stream to assert the resolver routes piped runs to agent mode.
  test("piped stdout (auto-on agent mode) still emits", () => {
    const { sinks, stdout } = captureSinks();
    // Simulate the runner's resolveOutputMode by passing flags that leave the
    // decision to TTY-detection and stubbing process.stdout.isTTY = false.
    const originalIsTTY = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      const piped: GlobalFlags = { ...TEST_GLOBALS, agent: false, human: false, json: false };
      const emit = buildSignInUrlEmitter(piped, sinks);
      expect(emit).toBeDefined();
      emit?.({ event: "sign_in_url", sign_in_url: "https://auth.test/y", state: "s2" });
      expect(stdout.buffer).toContain('"sign_in_url"');
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });
});

describe("authLoginHandler - GUSTO_ACCESS_TOKEN override warning", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.GUSTO_ACCESS_TOKEN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GUSTO_ACCESS_TOKEN;
    else process.env.GUSTO_ACCESS_TOKEN = saved;
  });

  const fakeLogin = () =>
    Promise.resolve({
      resource_owner: { type: "CompanyAdmin", uuid: "u-1" },
      resource: { type: "Company", uuid: "co-1" },
    });

  test("warns on stderr when GUSTO_ACCESS_TOKEN is set - login won't change the active identity", async () => {
    process.env.GUSTO_ACCESS_TOKEN = "env-tok";
    const { sinks, stderr } = captureSinks();
    const result = await authLoginHandler({}, { login: fakeLogin })({ ...ctx, sinks });
    expect(result.ok).toBe(true);
    expect(stderr.buffer).toContain("GUSTO_ACCESS_TOKEN");
    expect(stderr.buffer.toLowerCase()).toContain("warning");
  });

  test("no warning when GUSTO_ACCESS_TOKEN is unset", async () => {
    delete process.env.GUSTO_ACCESS_TOKEN;
    const { sinks, stderr } = captureSinks();
    const result = await authLoginHandler({}, { login: fakeLogin })({ ...ctx, sinks });
    expect(result.ok).toBe(true);
    expect(stderr.buffer).not.toContain("GUSTO_ACCESS_TOKEN");
  });
});

describe("authWhoamiHandler", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  test("augments token_info with a capabilities summary derived from scope", async () => {
    const tokenInfo = {
      scope: "employees:read employees:write pay_schedules:read",
      resource_owner: { type: "CompanyAdmin", uuid: "u-1" },
      resource: { type: "Company", uuid: "co-1" },
    };
    restore = stubGlobalFetch([{ status: 200, body: tokenInfo }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const data = result.data as Record<string, unknown>;
    const capabilities = data.capabilities as Array<{ resource: string; access: string[] }>;
    expect(capabilities).toContainEqual({ resource: "employees", access: ["read", "write"] });
    expect(capabilities).toContainEqual({ resource: "pay_schedules", access: ["read"] });
  });

  test("propagates a token_info error and skips the capabilities summary", async () => {
    restore = stubGlobalFetch([{ status: 401, body: { error: "invalid_token" } }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("api_client_error");
    expect("data" in result).toBe(false);
  });

  test("labels the credential source - GUSTO_ACCESS_TOKEN wins via the ambient env token", async () => {
    // tests/preload.ts sets GUSTO_ACCESS_TOKEN, so with no session the env token
    // is the resolved source; whoami should say so.
    const tokenInfo = { scope: "public", resource_owner: { type: "CompanyAdmin", uuid: "u-1" } };
    restore = stubGlobalFetch([{ status: 200, body: tokenInfo }]).restore;
    const result = await authWhoamiHandler({})(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as Record<string, unknown>).credential_source).toBe("GUSTO_ACCESS_TOKEN");
  });

  test("labels --token-stdin as the credential source when a token is piped", async () => {
    const tokenInfo = { scope: "public", resource_owner: { type: "CompanyAdmin", uuid: "u-1" } };
    restore = stubGlobalFetch([{ status: 200, body: tokenInfo }]).restore;
    const result = await authWhoamiHandler({ tokenStdin: true }, () => Promise.resolve("piped-tok"))(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as Record<string, unknown>).credential_source).toBe("--token-stdin");
  });
});

// The `session` branch is hard to drive through whoami without standing up a real
// session file; the underlying concern (a label typo slipping through) is captured
// by asserting the const map directly. `Record<TokenSource, string>` enforces
// exhaustive keys at compile time; this pins the values.
describe("CREDENTIAL_SOURCE_LABEL", () => {
  test("each TokenSource maps to the expected user-facing label", () => {
    expect(CREDENTIAL_SOURCE_LABEL.stdin).toBe("--token-stdin");
    expect(CREDENTIAL_SOURCE_LABEL.env).toBe("GUSTO_ACCESS_TOKEN");
    expect(CREDENTIAL_SOURCE_LABEL.session).toBe("stored session");
  });
});
