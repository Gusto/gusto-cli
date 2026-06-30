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
import { payrollPrepareHandler, payrollShowHandler, payrollUpdateHandler } from "./payroll.ts";

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

describe("payrollShowHandler", () => {
  test("GETs the company-scoped payroll path and returns the body", async () => {
    const payroll = { uuid: "pay-1", processing_status: "unprocessed" };
    const s = stub((u) => (u.includes("/payrolls/pay-1") ? { status: 200, body: payroll } : { status: 404 }));

    const d = data(await payrollShowHandler("pay-1", auth)(ctx));
    expect(d.uuid).toBe("pay-1");

    const get = s.calls.find((c) => c.method === "GET");
    expect(get?.url).toContain("/v1/companies/co-1/payrolls/pay-1");
  });

  test("passes --include through to the query string", async () => {
    const s = stub((u) => (u.includes("/payrolls/pay-1") ? { status: 200, body: { uuid: "pay-1" } } : { status: 404 }));
    await payrollShowHandler("pay-1", { ...auth, include: "totals,taxes" })(ctx);
    const get = s.calls.find((c) => c.method === "GET");
    expect(get?.url).toContain("include=totals%2Ctaxes");
  });

  test("an invalid --include token blocks with exit 7 before any request", async () => {
    const s = stub(() => ({ status: 500 }));
    const result = await payrollShowHandler("pay-1", { ...auth, include: "bogus" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toEqual(["include"]);
    expect(s.calls).toHaveLength(0);
  });

  test("percent-encodes the UUID so a stray '/' or '?' can't retarget the GET", async () => {
    const s = stub(() => ({ status: 404 }));
    await payrollShowHandler("evil?x=1/y", auth)(ctx);
    const get = s.calls.find((c) => c.method === "GET");
    expect(get?.url).toContain("/payrolls/evil%3Fx%3D1%2Fy");
    expect(get?.url).not.toContain("evil?x=1");
  });

  test("missing payroll_uuid blocks before any request", async () => {
    const s = stub(() => ({ status: 500 }));
    const result = await payrollShowHandler(undefined, auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(blockedFields(result)).toEqual(["payroll_uuid"]);
    expect(s.calls).toHaveLength(0);
  });

  test("a 404 (missing payroll) surfaces as a failed result", async () => {
    stub(() => ({ status: 404, body: { errors: [{ message: "not found" }] } }));
    const result = await payrollShowHandler("pay-1", auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });
});

/** A readFile stub that always returns the same CSV text, ignoring the path. */
const readingCsv = (csv: string) => async (): Promise<string> => csv;

describe("payrollUpdateHandler", () => {
  const CSV = "employee_uuid,job_uuid,regular_hours,bonus\nee-1,job-1,80,250";

  test("PUTs the parsed compensations to the company's payroll-update endpoint", async () => {
    const s = stub((u) => (u.includes("/payrolls/pay-1") ? { status: 200, body: { uuid: "pay-1" } } : { status: 404 }));

    const d = data(await payrollUpdateHandler("pay-1", { ...auth, input: "in.csv" }, readingCsv(CSV))(ctx));
    expect(d.uuid).toBe("pay-1");

    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/v1/companies/co-1/payrolls/pay-1");
    // The path must NOT be the prepare endpoint.
    expect(put?.url).not.toContain("/prepare");
    expect(put?.body).toEqual({
      employee_compensations: [
        {
          employee_uuid: "ee-1",
          hourly_compensations: [{ name: "Regular Hours", hours: 80, job_uuid: "job-1" }],
          fixed_compensations: [{ name: "Bonus", amount: 250, job_uuid: "job-1" }],
        },
      ],
    });
  });

  test("surfaces an API 422 (e.g. stale version) as a failed result with the upstream body", async () => {
    stub((u) =>
      u.includes("/payrolls/pay-1")
        ? { status: 422, body: { errors: [{ category: "invalid_attribute_value", message: "stale version" }] } }
        : { status: 404 },
    );
    const result = await payrollUpdateHandler("pay-1", { ...auth, input: "in.csv" }, readingCsv(CSV))(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
    expect(result.error.details).toMatchObject({ errors: [{ category: "invalid_attribute_value" }] });
  });

  test("dry-run describes the PUT and its body, and sends nothing", async () => {
    const s = stub(() => ({ status: 500 }));
    const d = data(
      await payrollUpdateHandler("pay-1", { ...auth, input: "in.csv", dryRun: true }, readingCsv(CSV))(ctx),
    );
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/companies/co-1/payrolls/pay-1");
    expect(d.body).toMatchObject({ employee_compensations: [{ employee_uuid: "ee-1" }] });
    expect(s.calls).toHaveLength(0);
  });

  test("percent-encodes the UUID so a stray '/' or '?' can't retarget the PUT", async () => {
    const s = stub(() => ({ status: 404 }));
    await payrollUpdateHandler("evil?x=1/y", { ...auth, input: "in.csv" }, readingCsv(CSV))(ctx);
    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/payrolls/evil%3Fx%3D1%2Fy");
    expect(put?.url).not.toContain("evil?x=1");
  });

  test("--example publishes the CSV columns and request shape without a uuid, auth, or request", async () => {
    const s = stub(() => ({ status: 500 }));
    const d = data(await payrollUpdateHandler(undefined, { example: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/companies/{company_uuid}/payrolls/{payroll_uuid}");
    expect((d.csv_columns as { required: string[] }).required).toEqual(["employee_uuid"]);
    expect(s.calls).toHaveLength(0);
  });

  test("missing payroll_uuid and --input both block before any request", async () => {
    const s = stub(() => ({ status: 500 }));
    const result = await payrollUpdateHandler(undefined, auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(blockedFields(result)).toEqual(["payroll_uuid", "input"]);
    expect(s.calls).toHaveLength(0);
  });

  test("an unreadable --input file is an invalid_input error, not a crash", async () => {
    const s = stub(() => ({ status: 500 }));
    const failingRead = async (): Promise<string> => {
      throw new Error("ENOENT: no such file");
    };
    const result = await payrollUpdateHandler("pay-1", { ...auth, input: "missing.csv" }, failingRead)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.code).toBe("invalid_input");
    expect(s.calls).toHaveLength(0);
  });

  test("reports skipped (no-input) employees in the result data", async () => {
    const s = stub((u) => (u.includes("/payrolls/pay-1") ? { status: 200, body: { uuid: "pay-1" } } : { status: 404 }));
    const csv = "employee_uuid,bonus\nee-1,250\nee-2,";
    const d = data(await payrollUpdateHandler("pay-1", { ...auth, input: "in.csv" }, readingCsv(csv))(ctx));
    expect(d.uuid).toBe("pay-1");
    expect(d.skipped_employees).toEqual([{ employee_uuid: "ee-2", line: 3 }]);
    // ee-2 must not have been sent in the body.
    const put = s.calls.find((c) => c.method === "PUT");
    expect((put?.body as { employee_compensations: { employee_uuid: string }[] }).employee_compensations).toHaveLength(
      1,
    );
  });

  test("an invalid CSV blocks with exit 7 before any request", async () => {
    const s = stub(() => ({ status: 500 }));
    const result = await payrollUpdateHandler("pay-1", { ...auth, input: "in.csv" }, readingCsv("nope\n1"))(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(s.calls).toHaveLength(0);
  });
});
