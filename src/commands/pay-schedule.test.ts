import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import { TEST_AUTH as auth, TEST_CONTEXT as ctx, blockedFields } from "../lib/test-support.ts";
import { payScheduleCreateHandler } from "../lib/pay-schedule.ts";

describe("payScheduleCreateHandler anchor_end_of_pay_period validation", () => {
  test("biweekly without --anchor-end-of-pay-period is refused pre-flight", async () => {
    const result = await payScheduleCreateHandler({ ...auth, frequency: "biweekly", firstPayday: "2026-07-03" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toContain("anchor-end-of-pay-period");
  });

  test("weekly also requires it", async () => {
    const result = await payScheduleCreateHandler({ ...auth, frequency: "weekly", firstPayday: "2026-07-03" })(ctx);
    expect(blockedFields(result)).toContain("anchor-end-of-pay-period");
  });

  test("biweekly with the anchor end date proceeds (dry-run shows it in the body)", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "biweekly",
      firstPayday: "2026-07-03",
      anchorEndOfPayPeriod: "2026-06-26",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({
      body: { frequency: "Every other week", anchor_pay_date: "2026-07-03", anchor_end_of_pay_period: "2026-06-26" },
    });
  });

  test("an unknown frequency string is refused with a validation error", async () => {
    const result = await payScheduleCreateHandler({ ...auth, frequency: "fortnightly", firstPayday: "2026-07-03" })(
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toContain("frequency");
  });

  test("monthly also requires it", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "monthly",
      firstPayday: "2026-07-31",
      day1: "31",
    })(ctx);
    expect(blockedFields(result)).toContain("anchor-end-of-pay-period");
  });
});

describe("payScheduleCreateHandler monthly", () => {
  test("monthly without --day-1 is refused pre-flight", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "monthly",
      firstPayday: "2026-07-31",
      anchorEndOfPayPeriod: "2026-07-31",
    })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toContain("day-1");
  });

  test("monthly does not require --day-2", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "monthly",
      firstPayday: "2026-07-31",
      anchorEndOfPayPeriod: "2026-07-31",
      day1: "31",
      dryRun: true,
    })(ctx);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  });

  test("monthly with --day-1 builds a Monthly body with day_1 and no day_2", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "monthly",
      firstPayday: "2026-07-31",
      anchorEndOfPayPeriod: "2026-07-31",
      day1: "31",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({
      body: {
        frequency: "Monthly",
        anchor_pay_date: "2026-07-31",
        anchor_end_of_pay_period: "2026-07-31",
        day_1: 31,
      },
    });
    expect((result.data as { body: Record<string, unknown> }).body).not.toHaveProperty("day_2");
  });

  test("a --day-2 on a monthly schedule is ignored, not sent", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "monthly",
      firstPayday: "2026-07-31",
      anchorEndOfPayPeriod: "2026-07-31",
      day1: "31",
      day2: "15",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as { body: Record<string, unknown> }).body).not.toHaveProperty("day_2");
  });
});

describe("payScheduleCreateHandler twice-per-month (semi-monthly)", () => {
  test("semi-monthly without --day-1 is refused", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "semi-monthly",
      firstPayday: "2026-07-15",
      anchorEndOfPayPeriod: "2026-07-15",
      day2: "30",
    })(ctx);
    expect(blockedFields(result)).toContain("day-1");
  });

  test("semi-monthly without --day-2 is refused", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "semi-monthly",
      firstPayday: "2026-07-15",
      anchorEndOfPayPeriod: "2026-07-15",
      day1: "15",
    })(ctx);
    expect(blockedFields(result)).toContain("day-2");
  });

  test("semi-monthly with both days builds a Twice per month body", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "semi-monthly",
      firstPayday: "2026-07-15",
      anchorEndOfPayPeriod: "2026-07-15",
      day1: "15",
      day2: "30",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({
      body: {
        frequency: "Twice per month",
        anchor_pay_date: "2026-07-15",
        anchor_end_of_pay_period: "2026-07-15",
        day_1: 15,
        day_2: 30,
      },
    });
  });
});

describe("payScheduleCreateHandler --example", () => {
  test("no frequency falls through to the biweekly shape", async () => {
    const result = await payScheduleCreateHandler({ ...auth, example: true })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({ body: { frequency: "Every other week" } });
  });

  test("monthly shows a Monthly shape with day_1 and no day_2", async () => {
    const result = await payScheduleCreateHandler({ ...auth, example: true, frequency: "monthly" })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({ body: { frequency: "Monthly", day_1: 31 } });
    expect((result.data as { body: Record<string, unknown> }).body).not.toHaveProperty("day_2");
  });

  test("semi-monthly shows a Twice per month shape with both days", async () => {
    const result = await payScheduleCreateHandler({ ...auth, example: true, frequency: "semi-monthly" })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({ body: { frequency: "Twice per month", day_1: 15, day_2: 30 } });
  });
});

describe("payScheduleCreateHandler day-of-month validation", () => {
  test("a non-integer --day-1 is refused", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "monthly",
      firstPayday: "2026-07-31",
      anchorEndOfPayPeriod: "2026-07-31",
      day1: "last",
    })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toContain("day-1");
  });

  test("a --day-1 outside 1-31 is refused", async () => {
    const result = await payScheduleCreateHandler({
      ...auth,
      frequency: "monthly",
      firstPayday: "2026-07-31",
      anchorEndOfPayPeriod: "2026-07-31",
      day1: "32",
    })(ctx);
    expect(blockedFields(result)).toContain("day-1");
  });
});
