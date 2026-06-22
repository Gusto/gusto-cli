import { afterEach, describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import {
  type MockResponse,
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  blockedFields,
  okData as data,
  stubGlobalFetch,
} from "../lib/test-support.ts";
import { payrollPrepareHandler } from "./payroll.ts";

let restore: () => void = () => {};
afterEach(() => restore());

/** Stub fetch with a router and expose the recorded calls so a test can assert which
 * request was (or wasn't) sent. */
function stub(router: (u: string) => MockResponse) {
  const s = stubGlobalFetch(router);
  restore = s.restore;
  return s;
}

describe("payrollPrepareHandler", () => {
  test("PUTs to the company's payroll prepare endpoint and returns the populated payroll", async () => {
    const prepared = {
      uuid: "pay-1",
      processing_status: "unprocessed",
      employee_compensations: [{ employee_uuid: "ee-1", gross_pay: "1600.00", regular_hours: "80.0" }],
    };
    const s = stub((u) => (u.includes("/payrolls/pay-1/prepare") ? { status: 200, body: prepared } : { status: 404 }));

    const d = data(await payrollPrepareHandler("pay-1", auth)(ctx));
    expect(d.uuid).toBe("pay-1");
    // The whole point of prepare: compensations are read back for verification.
    expect((d.employee_compensations as { employee_uuid: string }[])[0]?.employee_uuid).toBe("ee-1");

    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/v1/companies/co-1/payrolls/pay-1/prepare");
  });

  test("dry-run describes the PUT and sends nothing", async () => {
    const s = stub(() => ({ status: 500 })); // any real call would fail the test
    const d = data(await payrollPrepareHandler("pay-1", { ...auth, dryRun: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/companies/co-1/payrolls/pay-1/prepare");
    // prepare has no request body, so dry-run must not invent one.
    expect(d.body).toBeUndefined();
    expect(s.calls).toHaveLength(0);
  });

  test("percent-encodes the UUID segment so a stray '/' or '?' can't retarget the PUT", async () => {
    // An injection-y UUID (e.g. from agent/tool output) must stay one path segment: without
    // encoding, `?` would drop `/prepare` and hit the payroll-update endpoint instead.
    const s = stub(() => ({ status: 404 }));
    await payrollPrepareHandler("evil?x=1/y", auth)(ctx);
    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/payrolls/evil%3Fx%3D1%2Fy/prepare");
    // The dangerous shapes must NOT appear unescaped.
    expect(put?.url).not.toContain("evil?x=1");
    expect(put?.url).not.toContain("/y/prepare");
  });

  test("a 422 (no employees to prepare) surfaces the upstream body as a failed result", async () => {
    stub((u) =>
      u.includes("/prepare")
        ? { status: 422, body: { errors: [{ category: "invalid_operation", message: "no employees" }] } }
        : { status: 404 },
    );
    const result = await payrollPrepareHandler("pay-1", auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
    expect(result.error.details).toMatchObject({ errors: [{ category: "invalid_operation" }] });
  });

  test("--example publishes the path and response shape without a uuid, auth, or any request", async () => {
    const s = stub(() => ({ status: 500 })); // any real call would fail the test
    const d = data(await payrollPrepareHandler(undefined, { example: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/companies/{company_uuid}/payrolls/{payroll_uuid}/prepare");
    // No body key: prepare sends nothing.
    expect(d.body).toBeUndefined();
    expect(s.calls).toHaveLength(0);
  });

  test("missing payroll_uuid blocks before any request", async () => {
    const s = stub(() => ({ status: 500 }));
    const result = await payrollPrepareHandler(undefined, auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(blockedFields(result)).toEqual(["payroll_uuid"]);
    expect(s.calls).toHaveLength(0);
  });
});
