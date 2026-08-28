import { afterEach, describe, expect, test } from "bun:test";
import { pagedRouter, routeFetch, stubGlobalFetch, TEST_AUTH, TEST_CONTEXT } from "../lib/test-support.ts";
import { contractorPaymentGroupListHandler, contractorPaymentGroupShowHandler } from "./contractor-payment-group.ts";

const GROUP_UUID = "33333333-3333-3333-3333-333333333333";

let restore: () => void = () => {};
afterEach(() => restore());

describe("contractorPaymentGroupListHandler pagination", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ uuid: `cpg${i}` }));

  test("default returns the first page and a next (via X-Total-Pages)", async () => {
    restore = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorPaymentGroupListHandler({ ...TEST_AUTH })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(100);
    expect(result.next).toBeDefined();
  });

  test("--all concatenates every page with no next", async () => {
    restore = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorPaymentGroupListHandler({ ...TEST_AUTH, all: true })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(250);
    expect(result.next).toBeUndefined();
  });

  test("--limit within one page caps results and surfaces next", async () => {
    restore = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorPaymentGroupListHandler({ ...TEST_AUTH, limit: "40" })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(40);
    expect(result.next).toBeDefined();
  });

  test("malformed --cursor fails validation (exit 7)", async () => {
    const result = await contractorPaymentGroupListHandler({ ...TEST_AUTH, cursor: "garbage" })(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(7);
  });

  test("hits the company-scoped collection", async () => {
    const { calls, restore: r } = routeFetch([{ match: "/contractor_payment_groups", status: 200, body: [] }]);
    restore = r;
    await contractorPaymentGroupListHandler({ ...TEST_AUTH })(TEST_CONTEXT);
    expect(calls[0]?.url).toContain("/v1/companies/co-1/contractor_payment_groups");
  });

  test("passes --start-date/--end-date through as query params", async () => {
    const { calls, restore: r } = routeFetch([{ match: "/contractor_payment_groups", status: 200, body: [] }]);
    restore = r;
    await contractorPaymentGroupListHandler({ ...TEST_AUTH, startDate: "2026-01-01", endDate: "2026-12-31" })(
      TEST_CONTEXT,
    );
    expect(calls[0]?.url).toContain("start_date=2026-01-01");
    expect(calls[0]?.url).toContain("end_date=2026-12-31");
  });

  test("both --start-date/--end-date are optional (no query params sent when omitted)", async () => {
    const { calls, restore: r } = routeFetch([{ match: "/contractor_payment_groups", status: 200, body: [] }]);
    restore = r;
    await contractorPaymentGroupListHandler({ ...TEST_AUTH })(TEST_CONTEXT);
    expect(calls[0]?.url).not.toContain("start_date");
    expect(calls[0]?.url).not.toContain("end_date");
  });

  test("malformed --start-date fails validation (exit 7)", async () => {
    const result = await contractorPaymentGroupListHandler({ ...TEST_AUTH, startDate: "not-a-date" })(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(7);
  });
});

describe("contractorPaymentGroupShowHandler", () => {
  test("hits the bare /v1/contractor_payment_groups/{uuid} - not nested under /companies", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { uuid: GROUP_UUID } }));
    restore = stub.restore;
    const result = await contractorPaymentGroupShowHandler(GROUP_UUID, {})(TEST_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({ uuid: GROUP_UUID });
    expect(stub.calls[0]?.url).toContain(`/v1/contractor_payment_groups/${GROUP_UUID}`);
    expect(stub.calls[0]?.url).not.toContain("/companies/");
  });

  test("rejects a malformed contractor_payment_group_uuid without sending a request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = stub.restore;
    const result = await contractorPaymentGroupShowHandler("not-a-uuid", {})(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(stub.calls).toHaveLength(0);
    expect(result.error.hint).toBe(
      "run `gusto contractor-payment-group list` to get a real contractor_payment_group_uuid",
    );
  });
});
