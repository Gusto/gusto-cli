import { describe, expect, test } from "bun:test";
import { buildPayrollListQuery, buildPayrollUpdateFromCsv } from "./payroll.ts";

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

  test("accepts check_date and rejects any other date-filter-by", () => {
    expect(buildPayrollListQuery({ dateFilterBy: "check_date" })).toEqual({
      ok: true,
      query: { date_filter_by: "check_date" },
    });
    const bad = buildPayrollListQuery({ dateFilterBy: "checkdate" });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected failure");
    expect(bad.blocked).toContainEqual(expect.objectContaining({ field: "date-filter-by" }));
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

describe("buildPayrollUpdateFromCsv", () => {
  test("maps hourly, fixed, and reimbursement columns to the API names", () => {
    const csv = [
      "employee_uuid,version,job_uuid,regular_hours,bonus,commission,paycheck_tips,cash_tips,reimbursement",
      "ee-1,v1,job-1,80,250,100,15,40,30",
    ].join("\n");
    const result = buildPayrollUpdateFromCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body).toEqual({
      employee_compensations: [
        {
          employee_uuid: "ee-1",
          version: "v1",
          hourly_compensations: [{ name: "Regular Hours", hours: 80, job_uuid: "job-1" }],
          fixed_compensations: [
            { name: "Bonus", amount: 250, job_uuid: "job-1" },
            { name: "Commission", amount: 100, job_uuid: "job-1" },
            { name: "Paycheck Tips", amount: 15, job_uuid: "job-1" },
            { name: "Cash Tips", amount: 40, job_uuid: "job-1" },
          ],
          reimbursements: [{ amount: 30, description: "Reimbursement" }],
        },
      ],
    });
  });

  test("omits blank cells but keeps an explicit zero (blanks don't override, zeros do)", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,regular_hours,bonus\nee-1,0,");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const comp = result.body.employee_compensations[0];
    expect(comp?.hourly_compensations).toEqual([{ name: "Regular Hours", hours: 0 }]);
    // The blank bonus cell must not produce a fixed_compensations entry.
    expect(comp?.fixed_compensations).toBeUndefined();
  });

  test("omits job_uuid and version when those columns are absent", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\nee-1,500");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations[0]).toEqual({
      employee_uuid: "ee-1",
      fixed_compensations: [{ name: "Bonus", amount: 500 }],
    });
  });

  test("builds one compensation per row", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\nee-1,100\nee-2,200");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations.map((c) => c.employee_uuid)).toEqual(["ee-1", "ee-2"]);
  });

  test("ignores fully blank lines between rows", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\nee-1,100\n\nee-2,200\n");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations).toHaveLength(2);
  });

  test("rejects an unknown column", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,overtime_hours\nee-1,5");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "overtime_hours" }));
  });

  test("rejects a CSV missing the employee_uuid column", () => {
    const result = buildPayrollUpdateFromCsv("bonus\n100");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "employee_uuid" }));
  });

  test("rejects a CSV with no input columns", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,version\nee-1,v1");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "input" }));
  });

  test("reports a row missing employee_uuid with its line number", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\n,100");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 2: employee_uuid" }));
  });

  test("reports a non-numeric input value with its row and column", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\nee-1,abc");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 2: bonus" }));
  });

  test("rejects a negative amount", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\nee-1,-5");
    expect(result.ok).toBe(false);
  });

  test("flags a row that has an employee but no input values", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus,cash_tips\nee-1,,");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 2" }));
  });

  test("rejects an empty file", () => {
    const result = buildPayrollUpdateFromCsv("");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "input" }));
  });

  test("surfaces a malformed CSV (unterminated quote) as an input error", () => {
    const result = buildPayrollUpdateFromCsv('employee_uuid,bonus\nee-1,"oops');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "input" }));
  });

  test("rejects a duplicate employee_uuid instead of sending two ambiguous compensations", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\nee-1,250\nee-1,300");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 3: employee_uuid" }));
  });

  test("trims surrounding whitespace in headers and values", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid, bonus ,regular_hours\nee-1, 250 , 80 ");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations[0]).toEqual({
      employee_uuid: "ee-1",
      hourly_compensations: [{ name: "Regular Hours", hours: 80 }],
      fixed_compensations: [{ name: "Bonus", amount: 250 }],
    });
  });

  test("rejects currency-formatted values ($ and thousands separators) with a clear message", () => {
    const result = buildPayrollUpdateFromCsv('employee_uuid,bonus,cash_tips\nee-1,$500,"1,000"');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 2: bonus" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 2: cash_tips" }));
  });

  test("accepts decimal hours and amounts", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,regular_hours,bonus\nee-1,80.5,12.75");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const comp = result.body.employee_compensations[0];
    expect(comp?.hourly_compensations).toEqual([{ name: "Regular Hours", hours: 80.5 }]);
    expect(comp?.fixed_compensations).toEqual([{ name: "Bonus", amount: 12.75 }]);
  });
});
