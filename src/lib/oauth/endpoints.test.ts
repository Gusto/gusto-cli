import { describe, expect, test } from "bun:test";
import { expiresAtFrom, toTokenSet } from "./endpoints.ts";

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
