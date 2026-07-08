import { describe, expect, test } from "bun:test";
import { LOOPBACK_REDIRECT_URI, registerCliClient } from "./dcr.ts";
import { OAuthError } from "./endpoints.ts";
import { mockFetch } from "./test-support.ts";

describe("registerCliClient", () => {
  test("posts client_type=cli with a loopback redirect and returns creds", async () => {
    const { fetch, captured } = mockFetch({ status: 201, body: { client_id: "cid", client_secret: "sec" } });
    const creds = await registerCliClient({ baseUrl: "https://api.test", fetchImpl: fetch });

    expect(creds).toEqual({ clientId: "cid", clientSecret: "sec" });
    expect(captured.urls[0]).toBe("https://api.test/v1/mcp/oauth/register");
    const body = JSON.parse(String(captured.inits[0]?.body)) as Record<string, unknown>;
    expect(body.client_type).toBe("cli");
    expect(body.redirect_uris).toEqual([LOOPBACK_REDIRECT_URI]);
  });

  test("throws when the response lacks credentials", async () => {
    const { fetch } = mockFetch({ status: 201, body: { client_id: "cid" } });
    await expect(registerCliClient({ baseUrl: "https://api.test", fetchImpl: fetch })).rejects.toThrow(
      /missing client_id/,
    );
  });

  test("wraps a fetch/network failure in an OAuthError with status 0", async () => {
    const throwingFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const err = await registerCliClient({ baseUrl: "https://api.test", fetchImpl: throwingFetch }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).status).toBe(0);
    expect((err as OAuthError).message).toMatch(/network error/);
  });
});
