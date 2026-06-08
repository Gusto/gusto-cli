import { describe, expect, test } from "bun:test";
import { buildPayrollListQuery } from "./payroll.ts";

describe("buildPayrollListQuery", () => {
  test("no options yields an empty query", () => {
    expect(buildPayrollListQuery({})).toEqual({ ok: true, query: {} });
  });

  test("maps every flag to its API param name", () => {
    const result = buildPayrollListQuery({
      processingStatus: "processed,unprocessed",
      payrollType: "regular,off_cycle",
      startDate: "2026-01-01",
      endDate: "2026-03-01",
      dateFilterBy: "check_date",
      include: "taxes",
      sortOrder: "desc",
    });
    expect(result).toEqual({
      ok: true,
      query: {
        processing_statuses: "processed,unprocessed",
        payroll_types: "regular,off_cycle",
        start_date: "2026-01-01",
        end_date: "2026-03-01",
        date_filter_by: "check_date",
        include: "taxes",
        sort_order: "desc",
      },
    });
  });

  test("omits flags that were not supplied", () => {
    expect(buildPayrollListQuery({ startDate: "2026-01-01" })).toEqual({
      ok: true,
      query: { start_date: "2026-01-01" },
    });
  });

  test("rejects a malformed start-date with a blocked_on entry", () => {
    const result = buildPayrollListQuery({ startDate: "01-01-2026" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
  });

  test("rejects a malformed end-date with a blocked_on entry", () => {
    const result = buildPayrollListQuery({ endDate: "2026/03/01" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "end-date" }));
  });

  test("reports both dates when both are malformed", () => {
    const result = buildPayrollListQuery({ startDate: "nope", endDate: "also-nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "end-date" }));
  });

  test("rejects a well-formatted but impossible calendar date", () => {
    const result = buildPayrollListQuery({ startDate: "2026-02-30" });
    expect(result.ok).toBe(false);
  });

  test("accepts a valid ISO date", () => {
    expect(buildPayrollListQuery({ startDate: "2026-07-03" })).toEqual({
      ok: true,
      query: { start_date: "2026-07-03" },
    });
  });
});
