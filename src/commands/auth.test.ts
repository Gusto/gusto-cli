import { afterEach, describe, expect, test } from "bun:test";
import type { GlobalFlags } from "../lib/global-flags.ts";
import { TEST_CONTEXT as ctx, TEST_GLOBALS, captureSinks, stubGlobalFetch } from "../lib/test-support.ts";
import { memoryStore } from "../lib/oauth/test-support.ts";
import { authWhoamiHandler, buildSignInUrlEmitter, loginResultData, performLogout } from "./auth.ts";

// whoami's token resolution (session > env > --token-stdin) is delegated to
// fetchResource and covered by api-context.test.ts; the cases below cover the
// capabilities summary it layers on top. (AINT-588 dropped the --token override.)

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
});
