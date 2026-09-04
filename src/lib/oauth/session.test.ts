import { describe, expect, test } from "bun:test";
import { TokenRefreshFailedError } from "./refresh-failure.ts";
import { ensureClientCreds, reactiveRefresh, resolveSessionToken } from "./session.ts";
import { memoryStore, mockHttp as http } from "./test-support.ts";

describe("resolveSessionToken", () => {
  const creds = { clientId: "c", clientSecret: "s" };

  test("absent when there is no slot for the environment", async () => {
    const outcome = await resolveSessionToken(memoryStore(), "sandbox", http({ status: 200 }), () => 1_000);
    expect(outcome.kind).toBe("absent");
  });

  test("absent when the slot exists but carries no access token", async () => {
    // A slot holding only DCR client creds - the shape ensureClientCreds leaves behind when a login
    // was started and never completed.
    const store = memoryStore({ sandbox: creds });
    const outcome = await resolveSessionToken(store, "sandbox", http({ status: 200 }), () => 1_000);
    expect(outcome.kind).toBe("absent");
  });

  test("ok, with the token, when it is not near expiry", async () => {
    const store = memoryStore({ sandbox: { accessToken: "at", expiresAt: 10_000_000 } });
    const outcome = await resolveSessionToken(store, "sandbox", http({ status: 200 }), () => 1_000);
    expect(outcome).toEqual({ kind: "ok", token: "at" });
  });

  test("ok, with the refreshed token persisted, when a within-skew refresh succeeds", async () => {
    const store = memoryStore({ sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 2_000 } });
    const outcome = await resolveSessionToken(
      store,
      "sandbox",
      http({ status: 200, body: { access_token: "new", refresh_token: "rt2", expires_in: 3600 } }),
      () => 1_990, // within the 60s skew of expiresAt
    );
    expect(outcome).toEqual({ kind: "ok", token: "new" });
    expect(store.data.sandbox?.accessToken).toBe("new");
    expect(store.data.sandbox?.refreshToken).toBe("rt2");
  });

  test("expired when past expiry with no refresh token", async () => {
    const store = memoryStore({ sandbox: { accessToken: "old", expiresAt: 1_980 } });
    const outcome = await resolveSessionToken(store, "sandbox", http({ status: 200 }), () => 1_990);
    expect(outcome).toEqual({ kind: "expired", expiresAt: 1_980 });
  });

  test("expired when past expiry with a refresh token but no client creds to use it", async () => {
    // Nothing can authenticate the refresh call, so there is no refresh to attempt.
    const store = memoryStore({ sandbox: { accessToken: "old", refreshToken: "rt", expiresAt: 1_980 } });
    const outcome = await resolveSessionToken(store, "sandbox", http({ status: 200 }), () => 1_990);
    expect(outcome.kind).toBe("expired");
  });

  test("refresh_failed, carrying the cause, when the server rejects the refresh", async () => {
    const store = memoryStore({ sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 1_980 } });
    const outcome = await resolveSessionToken(
      store,
      "sandbox",
      http({ status: 400, body: { error: "invalid_grant" } }),
      () => 1_990,
    );
    expect(outcome.kind).toBe("refresh_failed");
    if (outcome.kind !== "refresh_failed") throw new Error("unreachable");
    expect(outcome.cause.status).toBe(400);
    expect(outcome.cause.body).toEqual({ error: "invalid_grant" });
  });

  test("uses a session another process refreshed while this refresh was rejected", async () => {
    const store = memoryStore({
      sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 1_980 },
    });
    const fetchImpl = (async (): Promise<Response> => {
      await store.save("sandbox", {
        ...creds,
        accessToken: "new",
        refreshToken: "rt2",
        expiresAt: 3_600_000,
      });
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const outcome = await resolveSessionToken(
      store,
      "sandbox",
      { baseUrl: "https://api.test", fetchImpl },
      () => 1_990,
    );

    expect(outcome).toEqual({ kind: "ok", token: "new" });
  });

  test("leaves the stored refresh token in place when the refresh is rejected", async () => {
    // The whole point of distinguishing this state: the refresh token is still the way back in, so
    // nothing here may discard it.
    const store = memoryStore({ sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 1_980 } });
    await resolveSessionToken(store, "sandbox", http({ status: 400 }), () => 1_990);
    expect(store.data.sandbox?.refreshToken).toBe("rt");
  });

  test("ok when a within-skew refresh fails but the token has not actually expired", async () => {
    const store = memoryStore({ sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 2_000 } });
    const outcome = await resolveSessionToken(store, "sandbox", http({ status: 400 }), () => 1_990);
    expect(outcome).toEqual({ kind: "ok", token: "old" });
  });

  test("an absent expiresAt means unknown, not expired - the token passes through", async () => {
    // Only a 401 from the API can disprove a token with no recorded expiry; refusing to send it
    // would strand a session that works.
    const store = memoryStore({ sandbox: { accessToken: "at" } });
    const outcome = await resolveSessionToken(store, "sandbox", http({ status: 200 }), () => 9_999_999);
    expect(outcome).toEqual({ kind: "ok", token: "at" });
  });

  test("a non-OAuth failure propagates rather than becoming a credential state", async () => {
    const broken = {
      load: () => Promise.reject(new Error("EACCES: permission denied")),
      save: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    await expect(resolveSessionToken(broken, "sandbox", http({ status: 200 }), () => 1_000)).rejects.toThrow("EACCES");
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

describe("reactiveRefresh", () => {
  const creds = { clientId: "c", clientSecret: "s" };

  test("uses a session another process refreshed while this refresh was rejected", async () => {
    const store = memoryStore({
      sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 10_000_000 },
    });
    const fetchImpl = (async (): Promise<Response> => {
      await store.save("sandbox", { ...creds, accessToken: "new", refreshToken: "rt2", expiresAt: 20_000_000 });
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const token = await reactiveRefresh(store, "sandbox", { baseUrl: "https://api.test", fetchImpl }, () => 1_000);
    expect(token).toBe("new");
  });

  test("re-classifies the other process's session rather than trusting it blindly - one more refresh when it's itself still near-expiry", async () => {
    // The other process's write beat ours, but its own session is still inside the skew window -
    // trusting its accessToken directly would hand back a token that fails again almost immediately.
    const store = memoryStore({
      sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 10_000_000 },
    });
    let refreshCalls = 0;
    const fetchImpl = (async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        // Our own attempt: a concurrent process wins the race and leaves behind a session that is
        // itself still near-expiry.
        await store.save("sandbox", { ...creds, accessToken: "stale2", refreshToken: "rt2", expiresAt: 1_030_000 });
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const token = await reactiveRefresh(store, "sandbox", { baseUrl: "https://api.test", fetchImpl }, () => 1_000_000);
    expect(token).toBe("fresh");
    expect(refreshCalls).toBe(2);
  });

  test("a rejected refresh with no concurrent change throws TokenRefreshFailedError wrapping the OAuthError", async () => {
    const store = memoryStore({
      sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 10_000_000 },
    });
    const result = reactiveRefresh(
      store,
      "sandbox",
      http({ status: 400, body: { error: "invalid_grant" } }),
      () => 1_000,
    );
    await expect(result).rejects.toBeInstanceOf(TokenRefreshFailedError);
    await expect(result).rejects.toMatchObject({ env: "sandbox", cause: expect.objectContaining({ status: 400 }) });
  });

  test("a second refresh attempt on reconciliation that also fails still throws TokenRefreshFailedError, not a loop", async () => {
    const store = memoryStore({
      sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 10_000_000 },
    });
    let refreshCalls = 0;
    const fetchImpl = (async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        await store.save("sandbox", { ...creds, accessToken: "stale2", refreshToken: "rt2", expiresAt: 1_030_000 });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as unknown as typeof fetch;

    await expect(
      reactiveRefresh(store, "sandbox", { baseUrl: "https://api.test", fetchImpl }, () => 1_000_000),
    ).rejects.toBeInstanceOf(TokenRefreshFailedError);
    expect(refreshCalls).toBe(2);
  });

  test("the reconciled session having logged out in the meantime still throws, rather than resolving null", async () => {
    const store = memoryStore({
      sandbox: { ...creds, accessToken: "old", refreshToken: "rt", expiresAt: 10_000_000 },
    });
    const fetchImpl = (async (): Promise<Response> => {
      await store.clear("sandbox");
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as unknown as typeof fetch;

    await expect(
      reactiveRefresh(store, "sandbox", { baseUrl: "https://api.test", fetchImpl }, () => 1_000),
    ).rejects.toBeInstanceOf(TokenRefreshFailedError);
  });

  test("null when there is nothing to refresh with, even after a concurrent-change check would apply", async () => {
    const store = memoryStore({ sandbox: { accessToken: "old" } });
    const token = await reactiveRefresh(store, "sandbox", http({ status: 200 }), () => 1_000);
    expect(token).toBeNull();
  });
});
