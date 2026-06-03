import { describe, expect, test } from "bun:test";
import { companyUuidFromTokenInfo, login } from "./login.ts";
import { memoryStore, mockFetch } from "./test-support.ts";

describe("companyUuidFromTokenInfo", () => {
  test("returns resource.uuid for a Company-scoped token", () => {
    expect(companyUuidFromTokenInfo({ resource: { type: "Company", uuid: "comp-1" } })).toBe("comp-1");
  });
  test("undefined when the resource is not a Company", () => {
    expect(companyUuidFromTokenInfo({ resource: { type: "Employee", uuid: "e-1" } })).toBeUndefined();
    expect(companyUuidFromTokenInfo({})).toBeUndefined();
  });
});

describe("login", () => {
  test("runs PKCE, reads token_info, and persists token + company_uuid", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } }); // creds present -> no DCR
    // Mock only the api.test calls (code exchange, then token_info). The loopback
    // redirect is hit with the REAL fetch so the local server actually responds.
    const { fetch: apiFetch } = mockFetch([
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } }, // code exchange
      {
        status: 200,
        body: {
          scope: "accounts:write",
          resource: { type: "Company", uuid: "comp-9" },
          resource_owner: { type: "PayrollAdmin", uuid: "po-1" },
        },
      }, // token_info
    ]);

    const openBrowser = async (authorizeUrl: string): Promise<void> => {
      const u = new URL(authorizeUrl);
      const redirect = u.searchParams.get("redirect_uri") as string;
      const state = u.searchParams.get("state") as string;
      await globalThis.fetch(`${redirect}?code=auth-code&state=${state}`);
    };

    const info = await login("sandbox", {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      openBrowser,
      print: () => {},
      timeoutMs: 5_000,
    });

    expect(info.resource?.uuid).toBe("comp-9");
    expect(store.data.sandbox?.accessToken).toBe("user-at");
    expect(store.data.sandbox?.refreshToken).toBe("rt");
    expect(store.data.sandbox?.companyUuid).toBe("comp-9");
  });
});
