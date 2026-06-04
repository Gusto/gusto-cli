import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  parseCallback,
  redirectUriForPort,
  startLoopbackServer,
} from "./pkce.ts";
import { formOf, mockFetch } from "./test-support.ts";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("generatePkce", () => {
  test("challenge is the S256 of the verifier, URL-safe", () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(base64Url(createHash("sha256").update(verifier).digest()));
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
});
