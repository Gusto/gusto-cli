import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  parseCallback,
  redirectUriForPort,
  refreshToken,
  startLoopbackServer,
} from "./pkce.ts";
import { formOf, mockFetch } from "./test-support.ts";

describe("generatePkce", () => {
  test("challenge is the S256 of the verifier, URL-safe", () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest().toString("base64url"));
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe("buildAuthorizeUrl", () => {
  test("includes PKCE + state params", () => {
    const url = new URL(
      buildAuthorizeUrl("https://api.test", {
        clientId: "cid",
        redirectUri: "http://127.0.0.1:5000/callback",
        challenge: "chal",
        state: "st",
      }),
    );
    expect(url.pathname).toBe("/v1/mcp/oauth/authorize");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5000/callback");
  });
});

describe("parseCallback", () => {
  test("extracts code/state/error", () => {
    expect(parseCallback("/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz", error: undefined });
    expect(parseCallback("/callback?error=access_denied")).toEqual({
      code: undefined,
      state: undefined,
      error: "access_denied",
    });
  });
});

describe("exchangeCode", () => {
  test("sends authorization_code + verifier and parses the token set", async () => {
    const { fetch, captured } = mockFetch({
      status: 200,
      body: { access_token: "at", refresh_token: "rt", expires_in: 7200 },
    });
    const tok = await exchangeCode(
      { baseUrl: "https://api.test", fetchImpl: fetch },
      {
        code: "code1",
        verifier: "ver",
        redirectUri: "http://127.0.0.1:5000/callback",
        creds: { clientId: "cid", clientSecret: "sec" },
      },
      1_000,
    );
    expect(tok).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: 1_000 + 7_200_000, scope: undefined });
    const form = formOf(captured.inits[0] ?? {});
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe("ver");
    expect(form.get("code")).toBe("code1");
  });
});

describe("refreshToken", () => {
  test("sends the refresh_token grant + parses the new token set", async () => {
    const { fetch, captured } = mockFetch({
      status: 200,
      body: { access_token: "new-at", refresh_token: "new-rt", expires_in: 7200 },
    });
    const tok = await refreshToken(
      { baseUrl: "https://api.test", fetchImpl: fetch },
      { refreshToken: "old-rt", creds: { clientId: "cid", clientSecret: "sec" } },
      1_000,
    );
    expect(tok).toEqual({
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: 1_000 + 7_200_000,
      scope: undefined,
    });
    const form = formOf(captured.inits[0] ?? {});
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("old-rt");
    expect(form.get("client_id")).toBe("cid");
  });
});

describe("startLoopbackServer", () => {
  test("captures the code when state matches", async () => {
    const server = await startLoopbackServer("good-state", { timeoutMs: 5_000 });
    const codeP = server.waitForCode();
    const res = await fetch(`${server.redirectUri}?code=the-code&state=good-state`);
    expect(res.status).toBe(200);
    expect(await codeP).toBe("the-code");
    expect(server.redirectUri).toBe(redirectUriForPort(server.port));
  });

  test("rejects on state mismatch", async () => {
    const server = await startLoopbackServer("expected", { timeoutMs: 5_000 });
    // Capture the rejection via an attached handler (avoids an unhandled-rejection window).
    const settled = server.waitForCode().then(
      () => null,
      (e: Error) => e,
    );
    await fetch(`${server.redirectUri}?code=x&state=attacker`);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/state mismatch/);
  });

  test("rejects when the callback carries an error param", async () => {
    const server = await startLoopbackServer("good-state", { timeoutMs: 5_000 });
    const settled = server.waitForCode().then(
      () => null,
      (e: Error) => e,
    );
    const res = await fetch(`${server.redirectUri}?error=access_denied&state=good-state`);
    expect(res.status).toBe(400);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/authorization failed: access_denied/);
  });

  test("rejects with a timeout when no callback arrives", async () => {
    const server = await startLoopbackServer("good-state", { timeoutMs: 10 });
    await expect(server.waitForCode()).rejects.toThrow(/timed out waiting for browser callback/);
  });
});
