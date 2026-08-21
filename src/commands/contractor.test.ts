import { afterEach, describe, expect, test } from "bun:test";
import { pagedRouter, stubGlobalFetch, TEST_AUTH, TEST_CONTEXT } from "../lib/test-support.ts";
import { contractorListHandler, contractorPaymentsHandler } from "./contractor.ts";

const CONTRACTOR_UUID = "11111111-1111-1111-1111-111111111111";

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

describe("contractorPaymentsHandler", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ uuid: `pay${i}` }));

  test("hits /v1/contractors/{uuid}/payments and passes the array through", async () => {
    const body = [{ uuid: "pay-1" }, { uuid: "pay-2" }];
    const stub = stubGlobalFetch(() => ({ status: 200, body }));
    restoreList = stub.restore;
    const result = await contractorPaymentsHandler(CONTRACTOR_UUID, {})(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(stub.calls[0]?.url).toContain(`/v1/contractors/${CONTRACTOR_UUID}/payments`);
    expect(result.data).toEqual(body);
  });

  test("--all concatenates every page with no next", async () => {
    restoreList = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorPaymentsHandler(CONTRACTOR_UUID, { all: true })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(250);
    expect(result.next).toBeUndefined();
  });

  test("passes --sort-by through as sort_by", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restoreList = stub.restore;
    await contractorPaymentsHandler(CONTRACTOR_UUID, { sortBy: "check_date:desc" })(TEST_CONTEXT);
    expect(stub.calls[0]?.url).toContain("sort_by=check_date%3Adesc");
  });

  test("rejects an invalid --sort-by without sending a request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restoreList = stub.restore;
    const result = await contractorPaymentsHandler(CONTRACTOR_UUID, { sortBy: "bogus" })(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(stub.calls).toHaveLength(0);
  });

  test("rejects a malformed contractor_uuid without sending a request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restoreList = stub.restore;
    const result = await contractorPaymentsHandler("not-a-uuid", {})(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(stub.calls).toHaveLength(0);
  });
});
