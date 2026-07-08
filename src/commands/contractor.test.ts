import { afterEach, describe, expect, test } from "bun:test";
import { pagedRouter, stubGlobalFetch, TEST_AUTH, TEST_CONTEXT } from "../lib/test-support.ts";
import { contractorListHandler } from "./contractor.ts";

let restoreList: () => void = () => {};
afterEach(() => restoreList());

describe("contractorListHandler pagination", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ uuid: `c${i}` }));

  test("default returns the first page and a next (via X-Total-Pages)", async () => {
    restoreList = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorListHandler({ ...TEST_AUTH })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(100);
    expect(result.next).toBeDefined();
  });

  test("--all concatenates every page with no next", async () => {
    restoreList = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorListHandler({ ...TEST_AUTH, all: true })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(250);
    expect(result.next).toBeUndefined();
  });

  test("--limit caps and emits no next", async () => {
    restoreList = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorListHandler({ ...TEST_AUTH, limit: "40" })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(40);
    expect(result.next).toBeUndefined();
  });

  test("malformed --cursor fails validation (exit 7)", async () => {
    const result = await contractorListHandler({ ...TEST_AUTH, cursor: "garbage" })(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(7);
  });
});
