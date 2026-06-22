import { afterEach, describe, expect, test } from "bun:test";
import { pagedRouter, stubGlobalFetch } from "./test-support.ts";
import { ApiClient } from "./api-client.ts";

let restore: () => void = () => {};
afterEach(() => restore());

function client(): ApiClient {
  return new ApiClient({
    baseUrl: "https://api.example.com",
    token: "t",
    apiVersion: "2026-02-01",
    retrySleepMs: () => 0,
  });
}

describe("pagedRouter", () => {
  test("slices by page and per", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ uuid: `u${i}` }));
    restore = stubGlobalFetch(pagedRouter(items)).restore;
    const page2 = await client().get<unknown[]>("/v1/things?page=2&per=10");
    expect((page2.body as unknown[]).map((x) => (x as { uuid: string }).uuid)).toEqual([
      "u10",
      "u11",
      "u12",
      "u13",
      "u14",
      "u15",
      "u16",
      "u17",
      "u18",
      "u19",
    ]);
  });

  test("emits pagination headers when asked", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ uuid: `u${i}` }));
    restore = stubGlobalFetch(pagedRouter(items, { withHeaders: true })).restore;
    const res = await client().get("/v1/things?page=1&per=10");
    expect(res.headers["x-total-pages"]).toBe("3");
    expect(res.headers["x-total-count"]).toBe("30");
  });

  test("omits headers by default (fullness-fallback fixtures)", async () => {
    restore = stubGlobalFetch(pagedRouter([{ uuid: "a" }])).restore;
    const res = await client().get("/v1/things?page=1&per=25");
    expect(res.headers["x-total-pages"]).toBeUndefined();
  });
});
