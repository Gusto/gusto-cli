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
  test("mints, POSTs /v1/provision, and returns the claim url without running OAuth", async () => {
    const store = memoryStore({ sandbox: { clientId: "cid", clientSecret: "sec" } }); // creds present -> no DCR
    const { fetch: apiFetch, captured } = mockFetch([
      SYSTEM_ACCESS, // system_access mint
      { status: 201, body: { account_claim_url: "https://claim/co-1" } }, // POST /v1/provision
    ]);

    const result = await provision("sandbox", EXAMPLE_PAYLOAD, {
      store,
      http: { baseUrl: "https://api.test", fetchImpl: apiFetch },
    });

    expect(result.accountClaimUrl).toBe("https://claim/co-1");
    // Non-blocking: provision does the mint + create and nothing else - no browser,
    // no claim wait, no OAuth code exchange.
    expect(captured.urls).toEqual(["https://api.test/v1/mcp/oauth/token", "https://api.test/v1/provision"]);
    // It must not log the user in: the store stays creds-only, no access token.
    expect(store.data.sandbox?.accessToken).toBeUndefined();
  });
});
