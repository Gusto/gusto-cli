import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPayPeriodsQuery,
  type PayPeriodsListOpts,
  payPeriodsListHandler,
  terminationPeriodsHandler,
} from "./pay-schedule.ts";
import { TEST_AUTH as auth, TEST_CONTEXT as ctx, blockedFields, okData, stubGlobalFetch } from "../lib/test-support.ts";

function okQuery(opts: PayPeriodsListOpts) {
  const parsed = buildPayPeriodsQuery(opts);
  if (!parsed.ok) throw new Error(`expected ok query, got ${JSON.stringify(parsed.blocked)}`);
  return parsed.query;
}

describe("buildPayPeriodsQuery", () => {
  test("no flags yields an empty query", () => {
    expect(okQuery({})).toEqual({});
  });

  test("dates and payroll_types pass through under their API names", () => {
    expect(okQuery({ startDate: "2026-01-01", endDate: "2026-03-31", payrollTypes: "regular,transition" })).toEqual({
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      payroll_types: "regular,transition",
    });
  });

  test("a malformed --start-date is refused", () => {
    const result = buildPayPeriodsQuery({ startDate: "01/01/2026" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked.map((b) => b.field)).toEqual(["start-date"]);
  });

  test("a malformed --end-date is refused", () => {
    const result = buildPayPeriodsQuery({ endDate: "not-a-date" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked.map((b) => b.field)).toEqual(["end-date"]);
  });

  test("an unknown --payroll-types value is refused", () => {
    const result = buildPayPeriodsQuery({ payrollTypes: "regular,off_cycle" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked.map((b) => b.field)).toEqual(["payroll-types"]);
  });

  test("payroll_types tolerates whitespace after the comma (server strips it)", () => {
    expect(okQuery({ payrollTypes: "regular, transition" }).payroll_types).toBe("regular, transition");
  });

  test("accumulates every invalid flag into one blocked_on list", () => {
    const result = buildPayPeriodsQuery({ startDate: "bad", endDate: "also-bad", payrollTypes: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked.map((b) => b.field)).toEqual(["start-date", "end-date", "payroll-types"]);
  });

  test("a comma/whitespace-only --payroll-types has no real tokens to reject (server treats it as default)", () => {
    // "," and " " trim/filter to zero tokens, so there is nothing invalid to block; the raw value is
    // forwarded and the server maps an empty payroll_types to its regular-only default.
    expect(okQuery({ payrollTypes: "," }).payroll_types).toBe(",");
    expect(okQuery({ payrollTypes: " " }).payroll_types).toBe(" ");
  });
});

describe("payPeriodsListHandler", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  const FIXTURE = [
    { start_date: "2026-01-01", end_date: "2026-01-15", pay_schedule_uuid: "ps-1" },
    { start_date: "2026-01-16", end_date: "2026-01-31", pay_schedule_uuid: "ps-1" },
  ];

  test("hits the company pay_periods endpoint and returns the body", async () => {
    const s = stubGlobalFetch(() => ({ status: 200, body: FIXTURE }));
    restore = s.restore;
    const result = await payPeriodsListHandler({ ...auth })(ctx);
    expect(result.ok).toBe(true);
    expect(okData(result)).toEqual(FIXTURE as unknown as Record<string, unknown>);
    expect(s.calls[0]?.url).toContain("/v1/companies/co-1/pay_periods");
  });

  test("forwards start_date/end_date/payroll_types as query params", async () => {
    const s = stubGlobalFetch(() => ({ status: 200, body: FIXTURE }));
    restore = s.restore;
    await payPeriodsListHandler({ ...auth, startDate: "2026-01-01", endDate: "2026-03-31", payrollTypes: "regular" })(
      ctx,
    );
    const url = s.calls[0]?.url ?? "";
    expect(url).toContain("start_date=2026-01-01");
    expect(url).toContain("end_date=2026-03-31");
    expect(url).toContain("payroll_types=regular");
  });

  test("an invalid flag short-circuits to a validation error without calling the API", async () => {
    const s = stubGlobalFetch(() => ({ status: 200, body: FIXTURE }));
    restore = s.restore;
    const result = await payPeriodsListHandler({ ...auth, startDate: "bad" })(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["start-date"]);
    expect(s.calls).toHaveLength(0);
  });

  test("a --company-uuid override scopes the endpoint to that company", async () => {
    const s = stubGlobalFetch(() => ({ status: 200, body: FIXTURE }));
    restore = s.restore;
    await payPeriodsListHandler({ companyUuid: "co-override" })(ctx);
    expect(s.calls[0]?.url).toContain("/v1/companies/co-override/pay_periods");
  });
});

describe("terminationPeriodsHandler", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  test("hits the unprocessed_termination_pay_periods endpoint and returns the body", async () => {
    const body = [{ start_date: "2026-02-01", end_date: "2026-02-15", pay_schedule_uuid: "ps-1" }];
    const s = stubGlobalFetch(() => ({ status: 200, body }));
    restore = s.restore;
    const result = await terminationPeriodsHandler({ ...auth })(ctx);
    expect(result.ok).toBe(true);
    expect(okData(result)).toEqual(body as unknown as Record<string, unknown>);
    expect(s.calls[0]?.url).toContain("/v1/companies/co-1/pay_periods/unprocessed_termination_pay_periods");
  });

  test("an empty array (no termination periods) passes through as success", async () => {
    const s = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restore = s.restore;
    const result = await terminationPeriodsHandler({ ...auth })(ctx);
    expect(result.ok).toBe(true);
    expect(okData(result)).toEqual([] as unknown as Record<string, unknown>);
  });

  test("a --company-uuid override scopes the endpoint to that company", async () => {
    const s = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restore = s.restore;
    await terminationPeriodsHandler({ companyUuid: "co-override" })(ctx);
    expect(s.calls[0]?.url).toContain("/v1/companies/co-override/pay_periods/unprocessed_termination_pay_periods");
  });
});
