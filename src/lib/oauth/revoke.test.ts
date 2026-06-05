import { describe, expect, test } from "bun:test";
import { revokeToken } from "./revoke.ts";
import { formOf, mockFetch } from "./test-support.ts";

const creds = { clientId: "cid", clientSecret: "sec" };

describe("revokeToken", () => {
  test("posts the token to /oauth/revoke and reports success", async () => {
    const { fetch, captured } = mockFetch({ status: 200 });
    const ok = await revokeToken({ baseUrl: "https://api.test", fetchImpl: fetch }, "tok", creds);

    expect(ok).toBe(true);
    expect(captured.urls[0]).toBe("https://api.test/oauth/revoke");
    expect(formOf(captured.inits[0] ?? {}).get("token")).toBe("tok");
  });

  test("non-2xx is non-fatal and returns false", async () => {
    const { fetch } = mockFetch({ status: 401, body: { error: "invalid_client" } });
    expect(await revokeToken({ baseUrl: "https://api.test", fetchImpl: fetch }, "tok", creds)).toBe(false);
  });
});
