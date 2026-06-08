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

  test("accepts every valid enum value (incl. external payroll type and index-only includes)", () => {
    const result = buildPayrollListQuery({
      processingStatus: "processed,unprocessed",
      payrollType: "regular,off_cycle,external",
      include: "taxes,totals,risk_blockers,reversals,payroll_status_meta",
      sortOrder: "asc",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects an invalid sort-order", () => {
    const result = buildPayrollListQuery({ sortOrder: "sideways" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "sort-order" }));
  });

  test("rejects an invalid processing-status token within a comma list", () => {
    const result = buildPayrollListQuery({ processingStatus: "processed,banana" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const entry = result.blocked.find((b) => b.field === "processing-status");
    expect(entry?.reason).toContain("banana");
  });

  test("rejects SHOW-only include values that the index endpoint ignores", () => {
    // benefits/deductions are valid on the show endpoint but NOT the index.
    const result = buildPayrollListQuery({ include: "benefits" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "include" }));
  });

  test("ignores empty tokens from trailing commas", () => {
    expect(buildPayrollListQuery({ payrollType: "regular," })).toEqual({
      ok: true,
      query: { payroll_types: "regular," },
    });
  });
});
