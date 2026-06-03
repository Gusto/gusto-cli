import { describe, expect, test } from "bun:test";
import { mintSystemAccess } from "./system-access.ts";
import { formOf, mockFetch } from "./test-support.ts";

describe("mintSystemAccess", () => {
  test("uses client-credentials Basic auth + system_access grant, no refresh", async () => {
    const { fetch, captured } = mockFetch({ status: 200, body: { access_token: "sys-tok", scope: "accounts:write" } });
    const token = await mintSystemAccess(
      { baseUrl: "https://api.test", fetchImpl: fetch },
      { clientId: "cid", clientSecret: "sec" },
    );

    expect(token.accessToken).toBe("sys-tok");
    expect(token.refreshToken).toBeUndefined();
    expect(captured.urls[0]).toBe("https://api.test/v1/mcp/oauth/token");
    const headers = captured.inits[0]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(formOf(captured.inits[0] ?? {}).get("grant_type")).toBe("system_access");
  });

  test("throws on missing access_token", async () => {
    const { fetch } = mockFetch({ status: 200, body: {} });
    await expect(
      mintSystemAccess({ baseUrl: "https://api.test", fetchImpl: fetch }, { clientId: "c", clientSecret: "s" }),
    ).rejects.toThrow(/missing access_token/);
  });
});
