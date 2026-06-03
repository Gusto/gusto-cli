import { describe, expect, test } from "bun:test";
import { ApiError } from "../api-client.ts";
import { ExitCode } from "../exit-codes.ts";
import { NoSessionError, getValidUserToken, withUserToken } from "./session.ts";
import { type MockResponse, memoryStore, mockFetch } from "./test-support.ts";

const http = (responses: MockResponse | MockResponse[]) => {
  const { fetch } = mockFetch(responses);
  return { baseUrl: "https://api.test", fetchImpl: fetch };
};

describe("getValidUserToken", () => {
  test("returns the stored token when not near expiry", async () => {
    const store = memoryStore({ sandbox: { accessToken: "at", expiresAt: 10_000_000 } });
    expect(await getValidUserToken(store, "sandbox", http({ status: 200 }), () => 1_000)).toBe("at");
  });

  test("returns null when there is no session", async () => {
    expect(await getValidUserToken(memoryStore(), "sandbox", http({ status: 200 }), () => 1_000)).toBeNull();
  });

  test("refreshes + persists when near expiry", async () => {
    const store = memoryStore({
      sandbox: { clientId: "c", clientSecret: "s", accessToken: "old", refreshToken: "rt", expiresAt: 2_000 },
    });
    const token = await getValidUserToken(
      store,
      "sandbox",
      http({ status: 200, body: { access_token: "new", refresh_token: "rt2", expires_in: 3600 } }),
      () => 1_990, // within the 60s skew of expiresAt
    );
    expect(token).toBe("new");
    expect(store.data.sandbox?.accessToken).toBe("new");
    expect(store.data.sandbox?.refreshToken).toBe("rt2");
  });
});

describe("withUserToken", () => {
  test("throws NoSessionError when not logged in", async () => {
    await expect(
      withUserToken(memoryStore(), "sandbox", http({ status: 200 }), () => Promise.resolve("x")),
    ).rejects.toThrow(NoSessionError);
  });

  test("refreshes once and retries on a 401", async () => {
    const store = memoryStore({
      sandbox: { clientId: "c", clientSecret: "s", accessToken: "at", refreshToken: "rt", expiresAt: 9_999_999_999 },
    });
    let calls = 0;
    const result = await withUserToken(
      store,
      "sandbox",
      http({ status: 200, body: { access_token: "refreshed", expires_in: 3600 } }),
      (token) => {
        calls += 1;
        if (calls === 1) {
          expect(token).toBe("at");
          throw new ApiError(401, null, ExitCode.Auth, "unauthorized");
        }
        expect(token).toBe("refreshed");
        return Promise.resolve("ok");
      },
      () => 1_000,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});
