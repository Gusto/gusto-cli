import { afterEach, describe, expect, test } from "bun:test";
import { routeFetch, stubGlobalFetch, TEST_AUTH, TEST_CONTEXT } from "../lib/test-support.ts";
import {
  contractorPaymentListHandler,
  contractorPaymentReceiptHandler,
  contractorPaymentShowHandler,
} from "./contractor-payment.ts";

const PAYMENT_UUID = "22222222-2222-2222-2222-222222222222";
const DATE_RANGE = { startDate: "2026-01-01", endDate: "2026-12-31" };

let restore: () => void = () => {};
afterEach(() => restore());

describe("contractorPaymentListHandler", () => {
  test("hits the company-scoped collection with start_date/end_date and passes the wrapped body through", async () => {
    const body = { total: { wages: "100.00", reimbursements: "0.00" }, contractor_payments: [{ uuid: "cp-1" }] };
    const { calls, restore: r } = routeFetch([{ match: "/contractor_payments", status: 200, body }]);
    restore = r;
    const result = await contractorPaymentListHandler({ ...TEST_AUTH, ...DATE_RANGE })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual(body);
    expect(calls[0]?.url).toContain("/v1/companies/co-1/contractor_payments");
    expect(calls[0]?.url).toContain("start_date=2026-01-01");
    expect(calls[0]?.url).toContain("end_date=2026-12-31");
  });

  test("missing --start-date/--end-date fails validation (exit 7) without sending a request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = stub.restore;
    const result = await contractorPaymentListHandler({ ...TEST_AUTH })(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(7);
    expect(stub.calls).toHaveLength(0);
  });

  test("malformed --start-date fails validation (exit 7) without sending a request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = stub.restore;
    const result = await contractorPaymentListHandler({ ...TEST_AUTH, startDate: "not-a-date", endDate: "2026-12-31" })(
      TEST_CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(7);
    expect(stub.calls).toHaveLength(0);
  });

  test("passes --contractor-uuid and --group-by-date through as query params", async () => {
    const body = { total: {}, contractor_payments: [] };
    const { calls, restore: r } = routeFetch([{ match: "/contractor_payments", status: 200, body }]);
    restore = r;
    await contractorPaymentListHandler({
      ...TEST_AUTH,
      ...DATE_RANGE,
      contractorUuid: "33333333-3333-3333-3333-333333333333",
      groupByDate: true,
    })(TEST_CONTEXT);
    expect(calls[0]?.url).toContain("contractor_uuid=33333333-3333-3333-3333-333333333333");
    expect(calls[0]?.url).toContain("group_by_date=true");
  });

  test("rejects a malformed --contractor-uuid without sending a request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = stub.restore;
    const result = await contractorPaymentListHandler({ ...TEST_AUTH, ...DATE_RANGE, contractorUuid: "not-a-uuid" })(
      TEST_CONTEXT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(7);
    expect(stub.calls).toHaveLength(0);
  });

  test("--all concatenates contractor_payments across pages and keeps the last total", async () => {
    let call = 0;
    const stub = stubGlobalFetch(() => {
      call += 1;
      const page = call === 1 ? [{ uuid: "cp-1" }] : [{ uuid: "cp-2" }];
      const status = 200;
      const headers = { "x-total-pages": "2" };
      return { status, headers, body: { total: { wages: String(call) }, contractor_payments: page } };
    });
    restore = stub.restore;
    const result = await contractorPaymentListHandler({ ...TEST_AUTH, ...DATE_RANGE, all: true })(TEST_CONTEXT);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    const data = result.data as { total: unknown; contractor_payments: unknown[] };
    expect(data.contractor_payments).toEqual([{ uuid: "cp-1" }, { uuid: "cp-2" }]);
    expect(data.total).toEqual({ wages: "2" });
    expect(result.next).toBeUndefined();
  });

  test("--limit within one page caps contractor_payments and surfaces next", async () => {
    let call = 0;
    const stub = stubGlobalFetch(() => {
      call += 1;
      const headers = { "x-total-pages": "5" };
      return { status: 200, headers, body: { total: { wages: "1" }, contractor_payments: [{ uuid: `cp-${call}` }] } };
    });
    restore = stub.restore;
    const result = await contractorPaymentListHandler({ ...TEST_AUTH, ...DATE_RANGE, limit: "3" })(TEST_CONTEXT);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    const data = result.data as { contractor_payments: unknown[] };
    expect(data.contractor_payments).toEqual([{ uuid: "cp-1" }, { uuid: "cp-2" }, { uuid: "cp-3" }]);
    expect(result.next).toBeDefined();
    expect(stub.calls).toHaveLength(3);
  });

  test("a wrapped body missing contractor_payments is rejected as malformed", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { total: {} } }));
    restore = stub.restore;
    const result = await contractorPaymentListHandler({ ...TEST_AUTH, ...DATE_RANGE })(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("malformed_response");
  });
});

describe("contractorPaymentShowHandler", () => {
  test("hits /v1/companies/{company}/contractor_payments/{uuid} and passes the body through", async () => {
    const { calls, restore: r } = routeFetch([
      { match: "/contractor_payments/", status: 200, body: { uuid: PAYMENT_UUID } },
    ]);
    restore = r;
    const result = await contractorPaymentShowHandler(PAYMENT_UUID, { ...TEST_AUTH })(TEST_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({ uuid: PAYMENT_UUID });
    expect(calls[0]?.url).toContain(`/v1/companies/co-1/contractor_payments/${PAYMENT_UUID}`);
  });

  test("rejects a malformed contractor_payment_uuid without sending a request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = stub.restore;
    const result = await contractorPaymentShowHandler("not-a-uuid", { ...TEST_AUTH })(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(stub.calls).toHaveLength(0);
    expect(result.error.hint).toBe("run `gusto contractor-payment list` to get a real contractor_payment_uuid");
  });
});

describe("contractorPaymentReceiptHandler", () => {
  test("hits the bare /v1/contractor_payments/{uuid}/receipt path (not company-scoped) and passes the body through", async () => {
    const body = { contractor_payment_uuid: PAYMENT_UUID, totals: { company_debit: "50.00" } };
    const { calls, restore: r } = routeFetch([{ match: "/receipt", status: 200, body }]);
    restore = r;
    const result = await contractorPaymentReceiptHandler(PAYMENT_UUID, {})(TEST_CONTEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual(body);
    expect(calls[0]?.url).toContain(`/v1/contractor_payments/${PAYMENT_UUID}/receipt`);
    expect(calls[0]?.url).not.toContain("/companies/");
  });

  test("rejects a malformed contractor_payment_uuid without sending a request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = stub.restore;
    const result = await contractorPaymentReceiptHandler("not-a-uuid", {})(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(result.error.hint).toBe("run `gusto contractor-payment list` to get a real contractor_payment_uuid");
    expect(stub.calls).toHaveLength(0);
  });
});
