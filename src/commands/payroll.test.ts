import { describe, expect, test } from "bun:test";
import { ApiClient, PollTimeoutError } from "../lib/api-client.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import {
  buildPayrollListQuery,
  buildPayrollShowQuery,
  buildPayrollUpdateFromCsv,
  executePayrollCalculate,
  isPayrollCalculated,
  isPayrollCalculationFailed,
  renderPayrollShow,
} from "./payroll.ts";

interface MockResponse {
  status: number;
  body?: unknown;
}

describe("buildPayrollShowQuery", () => {
  test("no include yields an empty query", () => {
    expect(buildPayrollShowQuery({})).toEqual({ ok: true, query: {} });
  });

  test("passes a valid include through verbatim", () => {
    expect(buildPayrollShowQuery({ include: "totals,taxes" })).toEqual({
      ok: true,
      query: { include: "totals,taxes" },
    });
  });

  test("accepts whitespace-padded tokens (the server strips them)", () => {
    const result = buildPayrollShowQuery({ include: "totals, taxes" });
    expect(result.ok).toBe(true);
  });

  test("rejects an unknown include token with a blocked_on entry", () => {
    const result = buildPayrollShowQuery({ include: "totals,bogus" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked[0]?.field).toBe("include");
    expect(result.blocked[0]?.reason).toContain("'bogus'");
  });

  test("rejects employee_compensations (not a valid show include)", () => {
    const result = buildPayrollShowQuery({ include: "employee_compensations" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked[0]?.reason).toContain("employee_compensations");
  });
});

describe("renderPayrollShow", () => {
  test("renders overview, totals, and a compensation table", () => {
    const out = renderPayrollShow({
      uuid: "pay-1",
      processed: true,
      check_date: "2026-07-15",
      pay_period: { start_date: "2026-07-01", end_date: "2026-07-15" },
      totals: { gross_pay: "1600.00", net_pay: "1200.00", employer_taxes: "150.00" },
      employee_compensations: [{ employee_uuid: "ee-1", gross_pay: "1600.00", net_pay: "1200.00" }],
    });
    expect(out).toContain("pay-1");
    expect(out).toContain("processed");
    expect(out).toContain("2026-07-01 to 2026-07-15");
    expect(out).toContain("Gross pay");
    expect(out).toContain("1600.00");
    expect(out).toContain("ee-1");
  });

  test("derives status from processed/calculated_at (no processing_status field exists)", () => {
    // Give each a comp so the empty-state hint (which mentions "calculated") can't pollute the
    // status assertion.
    const comp = [{ employee_uuid: "ee-1" }];
    expect(renderPayrollShow({ uuid: "pay-1", processed: false, employee_compensations: comp })).toMatch(
      /Status\s+unprocessed/,
    );
    expect(
      renderPayrollShow({
        uuid: "pay-1",
        processed: false,
        calculated_at: "2026-07-01T00:00:00Z",
        employee_compensations: comp,
      }),
    ).toMatch(/Status\s+calculated/);
    expect(renderPayrollShow({ uuid: "pay-1", processed: true, employee_compensations: comp })).toMatch(
      /Status\s+processed/,
    );
  });

  test("omits the totals block when totals are absent", () => {
    const out = renderPayrollShow({ uuid: "pay-1", employee_compensations: [{ employee_uuid: "ee-1" }] });
    expect(out).not.toContain("Totals");
    expect(out).toContain("ee-1");
  });

  test("omits the pay period line when only one date is present", () => {
    const out = renderPayrollShow({ uuid: "pay-1", pay_period: { start_date: "2026-07-01" } });
    expect(out).not.toContain("Pay period");
    expect(out).toContain("pay-1");
  });

  test("filters out non-object compensation entries without crashing", () => {
    const out = renderPayrollShow({ uuid: "pay-1", employee_compensations: [null, "nope"] });
    expect(out).toContain("has been calculated");
    expect(out).toContain("pay-1");
  });

  test("coerces non-string scalar compensation values instead of crashing", () => {
    const out = renderPayrollShow({
      uuid: "pay-1",
      employee_compensations: [{ employee_uuid: "ee-1", gross_pay: 1600, net_pay: null }],
    });
    expect(out).toContain("ee-1");
    expect(out).toContain("1600");
  });

  test("shows a not-yet-calculated hint when there are no compensations", () => {
    const out = renderPayrollShow({ uuid: "pay-1", processed: false, employee_compensations: [] });
    expect(out).toContain("has been calculated");
  });

  test("tolerates a malformed (non-array) compensations body", () => {
    const out = renderPayrollShow({ uuid: "pay-1", employee_compensations: "nope" });
    expect(out).toContain("has been calculated");
    expect(out).toContain("pay-1");
  });
});

describe("buildPayrollListQuery", () => {
  test("no options applies the client-side defaults: both statuses and regular payroll type (AINT-718)", () => {
    expect(buildPayrollListQuery({})).toEqual({
      ok: true,
      query: { processing_statuses: "processed,unprocessed", payroll_types: "regular" },
    });
  });

  test("an explicit --processing-status overrides the default", () => {
    expect(buildPayrollListQuery({ processingStatus: "processed" })).toEqual({
      ok: true,
      query: { processing_statuses: "processed", payroll_types: "regular" },
    });
  });

  test("an explicit unprocessed-only filter is preserved", () => {
    expect(buildPayrollListQuery({ processingStatus: "unprocessed" })).toEqual({
      ok: true,
      query: { processing_statuses: "unprocessed", payroll_types: "regular" },
    });
  });

  test("an explicit --payroll-type overrides the regular default", () => {
    expect(buildPayrollListQuery({ payrollType: "off_cycle" })).toEqual({
      ok: true,
      query: { processing_statuses: "processed,unprocessed", payroll_types: "off_cycle" },
    });
  });

  test("an empty filter value falls back to its default instead of dropping the param", () => {
    // "" would otherwise pass validateEnum (no tokens) and be dropped by toQueryString, silently
    // reverting to the server's own default. `||` keeps the documented client-side defaults.
    expect(buildPayrollListQuery({ processingStatus: "", payrollType: "" })).toEqual({
      ok: true,
      query: { processing_statuses: "processed,unprocessed", payroll_types: "regular" },
    });
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

  test("omits unsupplied flags but still applies the processing_statuses and payroll_types defaults", () => {
    expect(buildPayrollListQuery({ startDate: "2026-01-01" })).toEqual({
      ok: true,
      query: { processing_statuses: "processed,unprocessed", payroll_types: "regular", start_date: "2026-01-01" },
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
      query: { processing_statuses: "processed,unprocessed", payroll_types: "regular", start_date: "2026-07-03" },
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
      query: { processing_statuses: "processed,unprocessed", payroll_types: "regular", date_filter_by: "check_date" },
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
      query: { processing_statuses: "processed,unprocessed", payroll_types: "regular," },
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

  test("maps overtime and double-overtime columns to their default pay-type names", () => {
    const csv = ["employee_uuid,regular_hours,overtime_hours,double_overtime_hours", "ee-1,80,5,2"].join("\n");
    const result = buildPayrollUpdateFromCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations[0]?.hourly_compensations).toEqual([
      { name: "Regular Hours", hours: 80 },
      { name: "Overtime", hours: 5 },
      { name: "Double overtime", hours: 2 },
    ]);
  });

  test("overtime columns parse like regular_hours: an explicit 0 is kept, a blank cell is omitted", () => {
    // ee-1: overtime 0 (kept), double-overtime blank (omitted).
    // ee-2: overtime blank (omitted), double-overtime 0 (kept).
    const csv = ["employee_uuid,regular_hours,overtime_hours,double_overtime_hours", "ee-1,80,0,", "ee-2,80,,0"].join(
      "\n",
    );
    const result = buildPayrollUpdateFromCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations[0]?.hourly_compensations).toEqual([
      { name: "Regular Hours", hours: 80 },
      { name: "Overtime", hours: 0 },
    ]);
    expect(result.body.employee_compensations[1]?.hourly_compensations).toEqual([
      { name: "Regular Hours", hours: 80 },
      { name: "Double overtime", hours: 0 },
    ]);
  });

  test("merges regular and overtime across multiple jobs into one compensation", () => {
    const csv = ["employee_uuid,job_uuid,regular_hours,overtime_hours", "ee-1,job-a,30,5", "ee-1,job-b,20,3"].join(
      "\n",
    );
    const result = buildPayrollUpdateFromCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations).toHaveLength(1);
    expect(result.body.employee_compensations[0]?.hourly_compensations).toEqual([
      { name: "Regular Hours", hours: 30, job_uuid: "job-a" },
      { name: "Overtime", hours: 5, job_uuid: "job-a" },
      { name: "Regular Hours", hours: 20, job_uuid: "job-b" },
      { name: "Overtime", hours: 3, job_uuid: "job-b" },
    ]);
  });

  test("rejects a negative overtime value like any other hours column", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,overtime_hours\nee-1,-5");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 2: overtime_hours" }));
  });

  test("rejects a negative double-overtime value like any other hours column", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,double_overtime_hours\nee-1,-5");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 2: double_overtime_hours" }));
  });

  test("rejects an unknown column", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,holiday_hours\nee-1,5");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "holiday_hours" }));
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

  test("reports the true file line number when a blank line precedes the bad row", () => {
    // header=line1, blank=line2, bad row=line3. The error must cite row 3, not row 2.
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\n\nee-1,abc");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 3: bonus" }));
  });

  test("reports the true file line number for a skipped (no-input) row after a blank line", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\nee-1,100\n\nee-2,");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.skipped).toEqual([{ employee_uuid: "ee-2", line: 4 }]);
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

  test("reports an invalid or negative reimbursement with its row and column", () => {
    for (const bad of ["nope", "-5"]) {
      const result = buildPayrollUpdateFromCsv(`employee_uuid,reimbursement\nee-1,${bad}`);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 2: reimbursement" }));
    }
  });

  test("skips a no-input employee and reports it while importing the rest", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus,cash_tips\nee-1,250,\nee-2,,");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations.map((c) => c.employee_uuid)).toEqual(["ee-1"]);
    expect(result.skipped).toEqual([{ employee_uuid: "ee-2", line: 3 }]);
  });

  test("errors when every row has no input values", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus,cash_tips\nee-1,,\nee-2,,");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toBe("nothing to update");
  });

  test("does not report a blank row for an employee who has data on another row", () => {
    // ee-1 has data on row 2 (job-a) and a blank row 3 (job-b); the blank row is padding, not a skip.
    const csv = "employee_uuid,job_uuid,regular_hours\nee-1,job-a,30\nee-1,job-b,";
    const result = buildPayrollUpdateFromCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.skipped).toEqual([]);
    expect(result.body.employee_compensations).toHaveLength(1);
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

  test("rejects a repeated employee with no job_uuid (ambiguous duplicate)", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus\nee-1,250\nee-1,300");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 3: employee_uuid" }));
  });

  test("merges multiple rows for one employee (one per job) into a single compensation", () => {
    const csv = ["employee_uuid,job_uuid,regular_hours,cash_tips", "ee-1,job-a,30,40", "ee-1,job-b,25,"].join("\n");
    const result = buildPayrollUpdateFromCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations).toHaveLength(1);
    const comp = result.body.employee_compensations[0];
    expect(comp?.employee_uuid).toBe("ee-1");
    expect(comp?.hourly_compensations).toEqual([
      { name: "Regular Hours", hours: 30, job_uuid: "job-a" },
      { name: "Regular Hours", hours: 25, job_uuid: "job-b" },
    ]);
    expect(comp?.fixed_compensations).toEqual([{ name: "Cash Tips", amount: 40, job_uuid: "job-a" }]);
  });

  test("rejects the same (employee_uuid, job_uuid) pair appearing twice", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,job_uuid,regular_hours\nee-1,job-a,30\nee-1,job-a,25");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 3: employee_uuid" }));
  });

  test("rejects conflicting version values across one employee's job rows", () => {
    const result = buildPayrollUpdateFromCsv(
      "employee_uuid,version,job_uuid,regular_hours\nee-1,v1,job-a,30\nee-1,v2,job-b,25",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "row 3: version" }));
  });

  test("accepts a shared version across an employee's job rows", () => {
    const result = buildPayrollUpdateFromCsv(
      "employee_uuid,version,job_uuid,regular_hours\nee-1,v1,job-a,30\nee-1,v1,job-b,25",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations[0]?.version).toBe("v1");
  });

  test("matches headers case-insensitively", () => {
    const result = buildPayrollUpdateFromCsv("Employee_UUID,Regular_Hours,Bonus\nee-1,80,250");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations[0]).toEqual({
      employee_uuid: "ee-1",
      hourly_compensations: [{ name: "Regular Hours", hours: 80 }],
      fixed_compensations: [{ name: "Bonus", amount: 250 }],
    });
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

  test("pads a short row (fewer cells than the header) with blanks", () => {
    // Exporters often drop trailing empty columns; the missing trailing cells are treated as blank.
    const result = buildPayrollUpdateFromCsv("employee_uuid,regular_hours,bonus\nee-1,80");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.body.employee_compensations[0]).toEqual({
      employee_uuid: "ee-1",
      hourly_compensations: [{ name: "Regular Hours", hours: 80 }],
    });
  });

  test("treats a whitespace-only value as blank, not as a bad number", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,regular_hours,bonus\nee-1,80,   ");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const comp = result.body.employee_compensations[0];
    expect(comp?.hourly_compensations).toEqual([{ name: "Regular Hours", hours: 80 }]);
    expect(comp?.fixed_compensations).toBeUndefined();
  });

  test("rejects a duplicate column", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus,bonus\nee-1,250,300");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toBe("invalid CSV header");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "bonus" }));
  });

  test("rejects an empty header name from a trailing comma", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid,bonus,\nee-1,250,");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toBe("invalid CSV header");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "" }));
  });

  test("rejects a tab-delimited file (wrong delimiter) as a single unknown header", () => {
    const result = buildPayrollUpdateFromCsv("employee_uuid\tbonus\nee-1\t250");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toBe("invalid CSV header");
    // The whole tab-joined line is read as one column, so employee_uuid is "missing".
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "employee_uuid" }));
  });
});

describe("executePayrollCalculate", () => {
  const CO = "co-1";
  const PAYROLL = "pay-1";

  /** ApiClient whose fetch routes the calculate PUT and the totals GET to canned responses, so the
   * PUT-then-poll flow is testable without real waits (mirrors ledger.test.ts's clientWith). */
  function clientWith(responses: { put?: MockResponse; totals?: MockResponse }): ApiClient {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      let r: MockResponse | undefined;
      if (method === "PUT" && u.includes("/calculate")) r = responses.put;
      else if (method === "GET" && u.includes("include=totals")) r = responses.totals;
      if (!r) throw new Error(`unexpected request: ${method} ${u}`);
      const text = r.body !== undefined ? JSON.stringify(r.body) : "";
      return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return new ApiClient({
      baseUrl: "https://api.test",
      token: "t",
      apiVersion: "2026-02-01",
      fetchImpl,
      maxRetries: 0,
    });
  }

  test("waits for calculate_success and returns the payroll body with totals", async () => {
    const client = clientWith({
      put: { status: 202 },
      totals: {
        status: 200,
        body: {
          uuid: PAYROLL,
          processing_request: { status: "calculate_success" },
          totals: { company_debit: "1800.00" },
        },
      },
    });
    const result = await executePayrollCalculate(client, CO, PAYROLL, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect((result.data as { totals: { company_debit: string } }).totals.company_debit).toBe("1800.00");
  });

  test("--no-wait returns the calculating shape without polling", async () => {
    // No totals stub: if it polled, the fetch router would throw "unexpected request".
    const client = clientWith({ put: { status: 202 } });
    const result = await executePayrollCalculate(client, CO, PAYROLL, { wait: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data).toMatchObject({ status: "calculating", payroll_uuid: PAYROLL });
    expect(typeof (result.data as { note: string }).note).toBe("string");
  });

  test("a processing_failed status stops the poll and yields calculate_failed with the errors", async () => {
    const client = clientWith({
      put: { status: 202 },
      totals: {
        status: 200,
        body: { processing_request: { status: "processing_failed", errors: [{ message: "negative net pay" }] } },
      },
    });
    const result = await executePayrollCalculate(client, CO, PAYROLL, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("calculate_failed");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
    expect(result.error.details).toMatchObject({ errors: [{ message: "negative net pay" }] });
  });

  test("a timeout before any poll attempt yields calculate_timeout with attempts:0", async () => {
    // timeoutMs:0 => the deadline is already reached on entry, so poll throws before any GET.
    const client = clientWith({
      put: { status: 202 },
      totals: { status: 200, body: { processing_request: { status: "calculating" } } },
    });
    const result = await executePayrollCalculate(client, CO, PAYROLL, { timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("calculate_timeout");
    expect(result.exitCode).toBe(ExitCode.Timeout);
    const details = result.error.details as { attempts: number; last?: unknown };
    expect(details.attempts).toBe(0);
    expect("last" in details).toBe(false);
  });

  test("a timeout after one or more attempts carries the attempt count and last polled body", async () => {
    // Drive the PollTimeoutError -> details mapping directly (attempts>0, lastBody present) without a
    // real clock: a hand-built poll throws the error the catch block maps. The poll's own attempts/
    // lastBody population is covered in api-client.test.ts.
    const lastBody = { processing_request: { status: "calculating" } };
    const client = {
      request: async () => ({ body: null }),
      poll: async () => {
        throw new PollTimeoutError("timed out", 2, lastBody);
      },
    } as unknown as Pick<ApiClient, "request" | "poll">;
    const result = await executePayrollCalculate(client, CO, PAYROLL, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("calculate_timeout");
    const details = result.error.details as { attempts: number; last?: unknown };
    expect(details.attempts).toBe(2);
    expect(details.last).toEqual(lastBody);
  });

  test("a failed calculate PUT is mapped to an API error result", async () => {
    const client = clientWith({ put: { status: 422, body: { errors: [{ message: "not prepared" }] } } });
    const result = await executePayrollCalculate(client, CO, PAYROLL, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });
});

describe("payroll calculate poll predicates", () => {
  test("isPayrollCalculated matches only the calculate_success terminal state", () => {
    expect(isPayrollCalculated({ processing_request: { status: "calculate_success" } })).toBe(true);
    expect(isPayrollCalculated({ processing_request: { status: "calculating" } })).toBe(false);
    expect(isPayrollCalculated({ processing_request: { status: "processing_failed" } })).toBe(false);
    expect(isPayrollCalculated({ processing_request: null })).toBe(false);
    expect(isPayrollCalculated({})).toBe(false);
  });

  test("isPayrollCalculationFailed matches only the processing_failed terminal state", () => {
    expect(isPayrollCalculationFailed({ processing_request: { status: "processing_failed" } })).toBe(true);
    expect(isPayrollCalculationFailed({ processing_request: { status: "calculate_success" } })).toBe(false);
    expect(isPayrollCalculationFailed({ processing_request: { status: "calculating" } })).toBe(false);
    expect(isPayrollCalculationFailed({ processing_request: null })).toBe(false);
    expect(isPayrollCalculationFailed({})).toBe(false);
  });
});
