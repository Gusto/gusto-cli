import { describe, expect, test } from "bun:test";
import { TEST_AUTH as auth, TEST_CONTEXT as ctx, okData } from "../lib/test-support.ts";
import {
  timesheetCreateHandler,
  timesheetSyncHandler,
  validateTimesheetCreate,
  validateTimesheetSync,
} from "./timesheet.ts";

describe("validateTimesheetCreate", () => {
  const base = {
    employeeUuid: "emp-1",
    jobUuid: "job-1",
    start: "2026-06-01T09:00:00Z",
    timeZone: "America/New_York",
    regular: "8",
  };

  test("employee + job + regular hours + start + time-zone returns the populated body", () => {
    const result = validateTimesheetCreate(base);
    expect(result).toEqual({
      ok: true,
      body: {
        entity_uuid: "emp-1",
        entity_type: "Employee",
        time_zone: "America/New_York",
        shift_started_at: "2026-06-01T09:00:00Z",
        job_uuid: "job-1",
        entries: [{ hours_worked: 8, pay_classification: "Regular" }],
      },
    });
  });

  test("an employee without --job-uuid is blocked (job is required for employees)", () => {
    const result = validateTimesheetCreate({
      employeeUuid: "emp-1",
      start: "2026-06-01T09:00:00Z",
      timeZone: "America/New_York",
      regular: "8",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "job-uuid" }));
  });

  test("all three hour types map to the exact pay_classification enum strings", () => {
    const result = validateTimesheetCreate({
      ...base,
      regular: "8",
      overtime: "2",
      doubleOvertime: "1.5",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.entries).toEqual([
      { hours_worked: 8, pay_classification: "Regular" },
      { hours_worked: 2, pay_classification: "Overtime" },
      { hours_worked: 1.5, pay_classification: "Double overtime" },
    ]);
  });

  test("includes shift_ended_at and job_uuid when provided", () => {
    const result = validateTimesheetCreate({
      ...base,
      end: "2026-06-01T17:00:00Z",
      jobUuid: "job-9",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.shift_ended_at).toBe("2026-06-01T17:00:00Z");
    if (result.body.entity_type !== "Employee") throw new Error("expected employee body");
    expect(result.body.job_uuid).toBe("job-9");
  });

  test("--contractor-uuid sets entity_type Contractor and does NOT require a job", () => {
    const result = validateTimesheetCreate({
      contractorUuid: "ctr-1",
      start: "2026-06-01T09:00:00Z",
      timeZone: "America/New_York",
      regular: "8",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.entity_uuid).toBe("ctr-1");
    expect(result.body.entity_type).toBe("Contractor");
    expect(result.body).not.toHaveProperty("job_uuid");
  });

  test("a contractor with --job-uuid is rejected (contractors don't take a job)", () => {
    const result = validateTimesheetCreate({
      contractorUuid: "ctr-1",
      jobUuid: "job-1",
      start: "2026-06-01T09:00:00Z",
      timeZone: "America/New_York",
      regular: "8",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "job-uuid" }));
  });

  test("missing both entity uuids blocks on entity", () => {
    const result = validateTimesheetCreate({
      start: "2026-06-01T09:00:00Z",
      timeZone: "America/New_York",
      regular: "8",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "employee-uuid" }));
  });

  test("passing both employee and contractor uuid is rejected as ambiguous", () => {
    const result = validateTimesheetCreate({
      employeeUuid: "emp-1",
      contractorUuid: "ctr-1",
      start: "2026-06-01T09:00:00Z",
      timeZone: "America/New_York",
      regular: "8",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "employee-uuid" }));
  });

  test("missing --time-zone blocks on time-zone", () => {
    const result = validateTimesheetCreate({
      employeeUuid: "emp-1",
      start: "2026-06-01T09:00:00Z",
      regular: "8",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "time-zone" }));
  });

  test("missing --start blocks on start", () => {
    const result = validateTimesheetCreate({
      employeeUuid: "emp-1",
      timeZone: "America/New_York",
      regular: "8",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start" }));
  });

  test("no hour flags at all blocks on hours", () => {
    const result = validateTimesheetCreate({
      employeeUuid: "emp-1",
      start: "2026-06-01T09:00:00Z",
      timeZone: "America/New_York",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "hours" }));
  });

  test("a non-numeric hour value is rejected with the specific field, not the generic hours block", () => {
    const result = validateTimesheetCreate({ ...base, regular: "eight" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "regular" }));
    expect(result.blocked).not.toContainEqual(expect.objectContaining({ field: "hours" }));
  });

  test("a negative hour value is rejected with the specific field, not the generic hours block", () => {
    const result = validateTimesheetCreate({ ...base, overtime: "-2" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "overtime" }));
    expect(result.blocked).not.toContainEqual(expect.objectContaining({ field: "hours" }));
  });

  test("a malformed --start timestamp is blocked", () => {
    const result = validateTimesheetCreate({ ...base, start: "not-a-date" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start" }));
  });

  test("a malformed --end timestamp is blocked", () => {
    const result = validateTimesheetCreate({ ...base, end: "06/05/2026" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "end" }));
  });
});

describe("validateTimesheetSync", () => {
  const base = {
    payScheduleUuid: "ps-1",
    payPeriodStart: "2026-06-01",
    payPeriodEnd: "2026-06-15",
  };

  test("pay-schedule + period dates returns the populated body, kind is always regular", () => {
    const result = validateTimesheetSync(base);
    expect(result).toEqual({
      ok: true,
      body: {
        kind: "regular",
        pay_schedule_uuid: "ps-1",
        pay_period_start_date: "2026-06-01",
        pay_period_end_date: "2026-06-15",
      },
    });
  });

  test("missing --pay-schedule-uuid blocks on pay-schedule-uuid", () => {
    const result = validateTimesheetSync({
      payPeriodStart: "2026-06-01",
      payPeriodEnd: "2026-06-15",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "pay-schedule-uuid" }));
  });

  test("missing period dates block on both", () => {
    const result = validateTimesheetSync({ payScheduleUuid: "ps-1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "pay-period-start" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "pay-period-end" }));
  });

  test("a malformed --pay-period-start date is blocked", () => {
    const result = validateTimesheetSync({ ...base, payPeriodStart: "06/01/2026" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "pay-period-start" }));
  });

  test("a malformed --pay-period-end date is blocked", () => {
    const result = validateTimesheetSync({ ...base, payPeriodEnd: "not-a-date" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "pay-period-end" }));
  });
});

describe("timesheetCreateHandler", () => {
  test("--example returns the canonical request shape without auth", async () => {
    const data = okData(await timesheetCreateHandler({ example: true })(ctx));
    expect(data.method).toBe("POST");
    expect(data.path).toBe("/v1/companies/{company_uuid}/time_tracking/time_sheets");
    expect(data.body).toMatchObject({ entity_type: "Employee", job_uuid: expect.any(String) });
  });

  test("--dry-run builds the POST body from the flags", async () => {
    const data = okData(
      await timesheetCreateHandler({
        ...auth,
        employeeUuid: "emp-1",
        jobUuid: "job-1",
        start: "2026-06-01T09:00:00Z",
        timeZone: "America/New_York",
        regular: "8",
        dryRun: true,
      })(ctx),
    );
    expect(data.method).toBe("POST");
    expect(data.body).toMatchObject({
      entity_uuid: "emp-1",
      entity_type: "Employee",
      job_uuid: "job-1",
      entries: [{ hours_worked: 8, pay_classification: "Regular" }],
    });
  });

  test("invalid args short-circuit to a validation failure (exit 7) before any request", async () => {
    const result = await timesheetCreateHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("validation");
  });
});

describe("timesheetSyncHandler", () => {
  test("--example returns the canonical payroll-sync shape", async () => {
    const data = okData(await timesheetSyncHandler({ example: true })(ctx));
    expect(data.method).toBe("POST");
    expect(data.path).toBe("/v1/companies/{company_uuid}/time_tracking/payroll_syncs");
    expect(data.body).toMatchObject({ kind: "regular" });
  });

  test("--dry-run builds the POST body from the flags", async () => {
    const data = okData(
      await timesheetSyncHandler({
        ...auth,
        payScheduleUuid: "ps-1",
        payPeriodStart: "2026-06-01",
        payPeriodEnd: "2026-06-15",
        dryRun: true,
      })(ctx),
    );
    expect(data.method).toBe("POST");
    expect(data.body).toMatchObject({
      kind: "regular",
      pay_schedule_uuid: "ps-1",
      pay_period_start_date: "2026-06-01",
      pay_period_end_date: "2026-06-15",
    });
  });

  test("invalid args short-circuit to a validation failure (exit 7) before any request", async () => {
    const result = await timesheetSyncHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("validation");
  });
});
