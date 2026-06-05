import { describe, expect, test } from "bun:test";
import { memoryStore, mockHttp as http } from "../lib/oauth/test-support.ts";
import { loginResultData, performLogout, resolveWhoamiToken } from "./auth.ts";

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

describe("resolveWhoamiToken", () => {
  test("an override wins and the store is never consulted", async () => {
    expect(
      await resolveWhoamiToken(
        { baseUrl: "https://api.test", fetchImpl: noFetch },
        memoryStore(),
        "sandbox",
        "OVERRIDE",
      ),
    ).toBe("OVERRIDE");
  });

  test("falls back to the stored user token when there is no override", async () => {
    const store = memoryStore({ sandbox: { accessToken: "stored-at", expiresAt: 9_999_999_999 } });
    expect(await resolveWhoamiToken(http({ status: 200 }), store, "sandbox", null)).toBe("stored-at");
  });

  test("returns null with no override and no stored session", async () => {
    expect(await resolveWhoamiToken(http({ status: 200 }), memoryStore(), "sandbox", null)).toBeNull();
  });
});
