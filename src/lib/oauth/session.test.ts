import { describe, expect, test } from "bun:test";
import { ApiError } from "../api-client.ts";
import { ExitCode } from "../exit-codes.ts";
import { NoSessionError, ensureClientCreds, getValidUserToken, withUserToken } from "./session.ts";
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

  test("falls back to the current token when proactive refresh fails but it isn't expired yet", async () => {
    const store = memoryStore({
      sandbox: { clientId: "c", clientSecret: "s", accessToken: "old", refreshToken: "rt", expiresAt: 2_000 },
    });
    // now=1_990: within skew (refresh attempted) but not past expiry; refresh 400s.
    const token = await getValidUserToken(
      store,
      "sandbox",
      http({ status: 400, body: { error: "invalid_grant" } }),
      () => 1_990,
    );
    expect(token).toBe("old");
  });

  test("rethrows when refresh fails and the token is already expired", async () => {
    const store = memoryStore({
      sandbox: { clientId: "c", clientSecret: "s", accessToken: "old", refreshToken: "rt", expiresAt: 1_980 },
    });
    // now=1_990 is past expiry, so the stale token can't be used.
    await expect(getValidUserToken(store, "sandbox", http({ status: 400 }), () => 1_990)).rejects.toBeDefined();
  });
});

describe("ensureClientCreds", () => {
  test("registers + persists creds on first run when none are stored", async () => {
    const store = memoryStore();
    const creds = await ensureClientCreds(
      store,
      "sandbox",
      http({ status: 201, body: { client_id: "cid", client_secret: "sec" } }),
    );
    expect(creds).toEqual({ clientId: "cid", clientSecret: "sec" });
    expect(store.data.sandbox).toMatchObject({ clientId: "cid", clientSecret: "sec" });
  });

  test("reuses stored creds without a DCR call", async () => {
    const store = memoryStore({ sandbox: { clientId: "c", clientSecret: "s" } });
    const noFetch = (() => {
      throw new Error("should not DCR when creds are stored");
    }) as unknown as typeof fetch;
    const creds = await ensureClientCreds(store, "sandbox", { baseUrl: "https://api.test", fetchImpl: noFetch });
    expect(creds).toEqual({ clientId: "c", clientSecret: "s" });
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

  test("rethrows a non-401 ApiError without refreshing", async () => {
    const store = memoryStore({
      sandbox: { clientId: "c", clientSecret: "s", accessToken: "at", refreshToken: "rt", expiresAt: 9_999_999_999 },
    });
    await expect(
      withUserToken(
        store,
        "sandbox",
        http({ status: 200 }),
        () => {
          throw new ApiError(500, null, ExitCode.General, "server error");
        },
        () => 1_000,
      ),
    ).rejects.toThrow("server error");
  });

  test("rethrows the 401 when the session has no refresh token", async () => {
    const store = memoryStore({
      sandbox: { clientId: "c", clientSecret: "s", accessToken: "at", expiresAt: 9_999_999_999 },
    });
    await expect(
      withUserToken(
        store,
        "sandbox",
        http({ status: 200 }),
        () => {
          throw new ApiError(401, null, ExitCode.Auth, "unauthorized");
        },
        () => 1_000,
      ),
    ).rejects.toThrow("unauthorized");
  });

  test("propagates when the post-401 refresh itself fails", async () => {
    const store = memoryStore({
      sandbox: { clientId: "c", clientSecret: "s", accessToken: "at", refreshToken: "rt", expiresAt: 9_999_999_999 },
    });
    await expect(
      withUserToken(
        store,
        "sandbox",
        http({ status: 400, body: { error: "invalid_grant" } }), // refresh call fails
        () => {
          throw new ApiError(401, null, ExitCode.Auth, "unauthorized");
        },
        () => 1_000,
      ),
    ).rejects.toBeDefined();
  });
});
