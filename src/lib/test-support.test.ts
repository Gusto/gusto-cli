import { afterEach, describe, expect, test } from "bun:test";
import { pagedRouter, stubGlobalFetch, testApiClient } from "./test-support.ts";

let restore: () => void = () => {};
afterEach(() => restore());

describe("pagedRouter", () => {
  test("slices by page and per", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ uuid: `u${i}` }));
    restore = stubGlobalFetch(pagedRouter(items)).restore;
    const page2 = await testApiClient().get<unknown[]>("/v1/things?page=2&per=10");
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
    const res = await testApiClient().get("/v1/things?page=1&per=10");
    expect(res.headers["x-total-pages"]).toBe("3");
    expect(res.headers["x-total-count"]).toBe("30");
  });

  test("omits headers by default (fullness-fallback fixtures)", async () => {
    restore = stubGlobalFetch(pagedRouter([{ uuid: "a" }])).restore;
    const res = await testApiClient().get("/v1/things?page=1&per=25");
    expect(res.headers["x-total-pages"]).toBeUndefined();
  });
});
