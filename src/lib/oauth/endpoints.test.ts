import { describe, expect, test } from "bun:test";
import { OAuthError, expiresAtFrom, postForm, toTokenSet } from "./endpoints.ts";

describe("expiresAtFrom", () => {
  test("adds expires_in seconds to now", () => {
    expect(expiresAtFrom(3600, 1_000)).toBe(1_000 + 3_600_000);
    expect(expiresAtFrom(undefined, 1_000)).toBeUndefined();
  });
});

describe("toTokenSet", () => {
  test("parses a full token response", () => {
    expect(toTokenSet({ access_token: "at", refresh_token: "rt", expires_in: 7200, scope: "public" }, 1_000)).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1_000 + 7_200_000,
      scope: "public",
    });
  });

  test("leaves refresh/expiry undefined when absent (system_access case)", () => {
    expect(toTokenSet({ access_token: "sys", scope: "accounts:write" }, 1_000)).toEqual({
      accessToken: "sys",
      refreshToken: undefined,
      expiresAt: undefined,
      scope: "accounts:write",
    });
  });

  test("throws when access_token is missing", () => {
    expect(() => toTokenSet({ scope: "public" }, 1_000)).toThrow(/missing access_token/);
  });
});

describe("OAuthError on non-2xx responses", () => {
  test("a non-2xx token response throws OAuthError with the body + request_id", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "code already redeemed" }), {
          status: 400,
          headers: { "content-type": "application/json", "x-request-id": "req-token-1" },
        }),
      )) as unknown as typeof fetch;

    const err = await postForm({ baseUrl: "https://api.test", fetchImpl }, "/v1/mcp/oauth/token", {
      grant_type: "authorization_code",
      code: "c",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OAuthError);
    const oerr = err as OAuthError;
    expect(oerr.status).toBe(400);
    expect(oerr.body).toEqual({ error: "invalid_grant", error_description: "code already redeemed" });
    expect(oerr.requestId).toBe("req-token-1");
  });

  test("OAuthError.requestId is undefined when the server omits x-request-id", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;

    const err = await postForm({ baseUrl: "https://api.test", fetchImpl }, "/v1/mcp/oauth/token", {}).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).requestId).toBeUndefined();
  });
});
