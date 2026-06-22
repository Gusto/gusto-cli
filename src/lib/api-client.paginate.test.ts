import { afterEach, describe, expect, test } from "bun:test";
import { ApiClient } from "./api-client.ts";
import { decodeCursor } from "./pagination.ts";
import { pagedRouter, stubGlobalFetch } from "./test-support.ts";

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

const itemsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ uuid: `u${i}` }));

describe("ApiClient.paginate", () => {
  test("single page surfaces an opaque next when a full page comes back (fullness fallback)", async () => {
    restore = stubGlobalFetch(pagedRouter(itemsOf(250))).restore;
    const r = await client().paginate("/v1/things", { startPage: 1, per: 100, maxItems: 100 });
    expect(r.items).toHaveLength(100);
    expect(r.complete).toBe(false);
    expect(r.next).toBeDefined();
    expect(decodeCursor(r.next as string)).toEqual({ page: 2, per: 100 });
  });

  test("short final page completes with no next", async () => {
    restore = stubGlobalFetch(pagedRouter(itemsOf(40))).restore;
    const r = await client().paginate("/v1/things", { startPage: 1, per: 100, maxItems: 100 });
    expect(r.items).toHaveLength(40);
    expect(r.complete).toBe(true);
    expect(r.next).toBeUndefined();
  });

  test("--all walks every page and concatenates", async () => {
    restore = stubGlobalFetch(pagedRouter(itemsOf(1100))).restore;
    const r = await client().paginate("/v1/things", { startPage: 1, per: 500, maxItems: undefined });
    expect(r.items).toHaveLength(1100);
    expect(r.complete).toBe(true);
    expect(r.next).toBeUndefined();
  });

  test("--limit truncates to exactly maxItems across pages", async () => {
    restore = stubGlobalFetch(pagedRouter(itemsOf(1000))).restore;
    const r = await client().paginate("/v1/things", { startPage: 1, per: 500, maxItems: 600 });
    expect(r.items).toHaveLength(600);
    expect(r.complete).toBe(false);
  });

  test("uses X-Total-Pages when present (no extra empty fetch on exact multiple)", async () => {
    const calls = stubGlobalFetch(pagedRouter(itemsOf(100), { withHeaders: true }));
    restore = calls.restore;
    const r = await client().paginate("/v1/things", { startPage: 1, per: 100, maxItems: 100 });
    expect(r.items).toHaveLength(100);
    expect(r.complete).toBe(true);
    expect(r.next).toBeUndefined();
    expect(calls.calls).toHaveLength(1);
  });

  test("resumes from startPage", async () => {
    restore = stubGlobalFetch(pagedRouter(itemsOf(250))).restore;
    const r = await client().paginate<{ uuid: string }>("/v1/things", { startPage: 3, per: 100, maxItems: 100 });
    expect(r.items[0]?.uuid).toBe("u200");
  });
});
