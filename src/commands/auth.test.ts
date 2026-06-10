import { afterEach, describe, expect, test } from "bun:test";
import { TEST_CONTEXT as ctx, stubGlobalFetch } from "../lib/test-support.ts";
import { memoryStore, mockHttp as http } from "../lib/oauth/test-support.ts";
import { authWhoamiHandler, loginResultData, performLogout } from "./auth.ts";

// whoami's token resolution (session > env > --token-stdin) is delegated to
// fetchResource and covered by api-context.test.ts; the cases below cover the
// capabilities summary it layers on top. (AINT-588 dropped the --token override.)

const noFetch = (() => {
  throw new Error("network must not be hit");
}) as unknown as typeof fetch;

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
  test("no stored session -> revoked:false with a note", async () => {
    expect(await performLogout(http({ status: 200 }), memoryStore(), "sandbox")).toEqual({
      revoked: false,
      note: "no stored session",
    });
  });

  test("revokes and clears when a session with creds exists", async () => {
    const store = memoryStore({ sandbox: { clientId: "c", clientSecret: "s", accessToken: "at" } });
    expect(await performLogout(http({ status: 200 }), store, "sandbox")).toEqual({ revoked: true });
    expect(store.data.sandbox).toBeUndefined();
  });

  test("a non-2xx revoke is non-fatal: revoked:false but still cleared", async () => {
    const store = memoryStore({ sandbox: { clientId: "c", clientSecret: "s", accessToken: "at" } });
    expect(await performLogout(http({ status: 401 }), store, "sandbox")).toEqual({ revoked: false });
    expect(store.data.sandbox).toBeUndefined();
  });

  test("a session without client creds clears without attempting revoke", async () => {
    const store = memoryStore({ sandbox: { accessToken: "at" } });
    expect(await performLogout({ baseUrl: "https://api.test", fetchImpl: noFetch }, store, "sandbox")).toEqual({
      revoked: false,
    });
    expect(store.data.sandbox).toBeUndefined();
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
