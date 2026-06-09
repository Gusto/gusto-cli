import { describe, expect, test } from "bun:test";
import { ApiError } from "../api-client.ts";
import { EXAMPLE_PAYLOAD } from "./provision-input.ts";
import { callProvision, provision } from "./provision.ts";
import { memoryStore, mockFetch } from "./test-support.ts";

const creds = { clientId: "cid", clientSecret: "sec" };
const SYSTEM_ACCESS = { status: 200, body: { access_token: "sys-tok", scope: "public accounts:write" } };

describe("callProvision", () => {
  test("mints system_access then POSTs /v1/provision and returns account_claim_url", async () => {
    const { fetch, captured } = mockFetch([
      SYSTEM_ACCESS,
      { status: 201, body: { account_claim_url: "https://claim/abc" } },
    ]);
    const url = await callProvision({ baseUrl: "https://api.test", fetchImpl: fetch }, creds, EXAMPLE_PAYLOAD);

    expect(url).toBe("https://claim/abc");
    expect(captured.urls[0]).toBe("https://api.test/v1/mcp/oauth/token"); // mint
    expect(captured.urls[1]).toBe("https://api.test/v1/provision"); // provision
    expect(JSON.parse(String(captured.inits[1]?.body))).toEqual(EXAMPLE_PAYLOAD); // unwrapped body
  });

  test("does not retry the non-idempotent create on a 401", async () => {
    const { fetch, captured } = mockFetch([SYSTEM_ACCESS, { status: 401, body: { error: "invalid_token" } }]);
    await expect(
      callProvision({ baseUrl: "https://api.test", fetchImpl: fetch }, creds, EXAMPLE_PAYLOAD),
    ).rejects.toBeInstanceOf(ApiError);
    expect(captured.urls.length).toBe(2); // mint + a single provision POST, no retry
  });

  test("propagates a non-401 error without retrying", async () => {
    const { fetch, captured } = mockFetch([SYSTEM_ACCESS, { status: 500, body: { error: "boom" } }]);
    await expect(
      callProvision({ baseUrl: "https://api.test", fetchImpl: fetch }, creds, EXAMPLE_PAYLOAD),
    ).rejects.toBeInstanceOf(ApiError);
    expect(captured.urls.length).toBe(2); // no retry
  });

  test("throws when the response is missing account_claim_url", async () => {
    const { fetch } = mockFetch([SYSTEM_ACCESS, { status: 201, body: {} }]);
    await expect(
      callProvision({ baseUrl: "https://api.test", fetchImpl: fetch }, creds, EXAMPLE_PAYLOAD),
    ).rejects.toThrow(/missing account_claim_url/);
  });
});

describe("provision", () => {
  test("drives mint -> /v1/provision -> claim -> Mode 2 login and returns the claim url + identity", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } }); // creds present -> no DCR
    const { fetch: apiFetch } = mockFetch([
      SYSTEM_ACCESS, // system_access mint
      { status: 201, body: { account_claim_url: "https://claim/co-1" } }, // POST /v1/provision
      { status: 200, body: { access_token: "user-at", refresh_token: "rt", expires_in: 7200 } }, // Mode 2 code exchange
      { status: 200, body: { resource: { type: "Company", uuid: "comp-1" } } }, // token_info
    ]);

    // Drive only the Mode 2 authorize URL through the loopback; the claim URL is a no-op.
    const openBrowser = async (url: string): Promise<void> => {
      if (!url.includes("/oauth/authorize")) return;
      const u = new URL(url);
      await globalThis.fetch(`${u.searchParams.get("redirect_uri")}?code=c&state=${u.searchParams.get("state")}`);
    };

    const result = await provision("sandbox", EXAMPLE_PAYLOAD, {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
      openBrowser,
      confirmClaim: () => Promise.resolve(),
      print: () => {},
    });

    expect(result.accountClaimUrl).toBe("https://claim/co-1");
    expect(result.tokenInfo.resource?.uuid).toBe("comp-1");
    expect(store.data.sandbox?.accessToken).toBe("user-at");
    expect(store.data.sandbox?.companyUuid).toBe("comp-1");
  });
});
