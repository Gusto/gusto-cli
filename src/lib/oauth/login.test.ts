import { describe, expect, test } from "bun:test";
import { companyUuidFromTokenInfo, login, openOrPrint } from "./login.ts";
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

describe("openOrPrint", () => {
  test("prints the opened-browser hint when the opener succeeds", async () => {
    const lines: string[] = [];
    await openOrPrint(
      "https://auth.test/go",
      () => Promise.resolve(),
      (l) => lines.push(l),
    );
    expect(lines[0]).toMatch(/Opened your browser/);
    expect(lines.join("\n")).toContain("https://auth.test/go");
  });

  test("falls back to a manual-URL prompt when the opener rejects", async () => {
    const lines: string[] = [];
    await openOrPrint(
      "https://auth.test/go",
      () => Promise.reject(new Error("no opener")),
      (l) => lines.push(l),
    );
    expect(lines[0]).toMatch(/Open this URL in your browser/);
    expect(lines.join("\n")).toContain("https://auth.test/go");
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
  });
});
