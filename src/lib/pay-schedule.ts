import type { Command } from "commander";
import { createCompanyResource } from "./api-context.ts";
import { type BlockedOn } from "./output.ts";
import { type CommandHandler, type ValidationResult, missingArgs } from "./runner.ts";

export type PayFrequency = "Every week" | "Every other week" | "Monthly" | "Twice per month";

export const FREQUENCY_MAP: Record<string, PayFrequency> = {
  weekly: "Every week",
  biweekly: "Every other week",
  "bi-weekly": "Every other week",
  monthly: "Monthly",
  "semi-monthly": "Twice per month",
  semimonthly: "Twice per month",
};

// Discriminated on `frequency` so the compiler enforces the API's per-frequency
// contract: monthly carries a single day-of-month, twice-per-month carries two,
// and the week-based frequencies carry neither.
type PayScheduleBody =
  | { frequency: "Every week" | "Every other week"; anchor_pay_date: string; anchor_end_of_pay_period: string }
  | { frequency: "Monthly"; anchor_pay_date: string; anchor_end_of_pay_period: string; day_1: number }
  | {
      frequency: "Twice per month";
      anchor_pay_date: string;
      anchor_end_of_pay_period: string;
      day_1: number;
      day_2: number;
    };

export interface PayScheduleCreateOpts {
  frequency?: string;
  firstPayday?: string;
  anchorPayDate?: string;
  anchorEndOfPayPeriod?: string;
  day1?: string;
  day2?: string;
  companyUuid?: string;
  token?: string;
  dryRun?: boolean;
  example?: boolean;
}

/** Register the create-pay-schedule domain flags shared by `gusto pay-schedule create`
 * and `gusto company setup pay-schedule`. Each command adds its own auth/dry-run/example
 * options on top. */
export function addPayScheduleOptions(cmd: Command): Command {
  return cmd
    .option("--frequency <freq>", `Pay frequency: ${Object.keys(FREQUENCY_MAP).join(", ")}`)
    .option("--first-payday <date>", "First payday (YYYY-MM-DD); the API names this `anchor_pay_date`")
    .option("--anchor-pay-date <date>", "Alias for --first-payday")
    .option("--anchor-end-of-pay-period <date>", "Anchor end-of-period (YYYY-MM-DD)")
    .option("--day-1 <n>", "Day of month for the (first) payday; required for monthly + semi-monthly")
    .option("--day-2 <n>", "Day of month for the second payday; required for semi-monthly");
}

type DayParse = { ok: true; value: number } | { ok: false; reason: string };

/** Parse a `--day-1`/`--day-2` value into a 1-31 day-of-month, or explain why it's bad. */
function parseDayOfMonth(raw: string | undefined, frequency: PayFrequency, flag: string): DayParse {
  if (raw === undefined || raw === "") {
    return {
      ok: false,
      reason: `required for ${frequency.toLowerCase()} schedules (${flag} = day of the month, 1-31)`,
    };
  }
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < 1 || n > 31) {
    return { ok: false, reason: `must be a whole number between 1 and 31 (got '${raw}')` };
  }
  return { ok: true, value: n };
}

/** Validate the create options in a single pass and assemble the request body. Collects
 * every missing/invalid field at once so the caller can report them together. */
function validatePayScheduleCreate(opts: PayScheduleCreateOpts): ValidationResult<PayScheduleBody> {
  const frequency = FREQUENCY_MAP[(opts.frequency ?? "").toLowerCase()];
  const anchorPayDate = opts.anchorPayDate ?? opts.firstPayday;
  const anchorEnd = opts.anchorEndOfPayPeriod;
  const blocked: BlockedOn[] = [];

  if (!opts.frequency) {
    blocked.push({ field: "frequency", reason: "required" });
  } else if (!frequency) {
    blocked.push({
      field: "frequency",
      reason: `unknown frequency '${opts.frequency}'; valid: ${Object.keys(FREQUENCY_MAP).join(", ")}`,
    });
  }
  if (!anchorPayDate) {
    blocked.push({ field: "first-payday", reason: "required (use --first-payday or --anchor-pay-date)" });
  }
  if (frequency && !anchorEnd) {
    blocked.push({
      field: "anchor-end-of-pay-period",
      reason: `required for ${frequency.toLowerCase()} schedules (YYYY-MM-DD, end of the first pay period)`,
    });
  }

  // No typed body is possible without a known frequency and both anchor dates, so
  // bail here; the per-frequency day flags are validated inside each branch below.
  if (!frequency || !anchorPayDate || !anchorEnd) {
    return { ok: false, message: "missing required arguments", blocked };
  }
  const anchors = { anchor_pay_date: anchorPayDate, anchor_end_of_pay_period: anchorEnd };
  const bail = (): ValidationResult<PayScheduleBody> => ({ ok: false, message: "missing required arguments", blocked });

  // Exhaustive over PayFrequency (no `default`): a new frequency forces a compile
  // error here, and each body is built where its day flags are provably set.
  switch (frequency) {
    case "Every week":
    case "Every other week":
      return blocked.length > 0 ? bail() : { ok: true, body: { frequency, ...anchors } };
    case "Monthly": {
      const day1 = parseDayOfMonth(opts.day1, frequency, "--day-1");
      if (!day1.ok) blocked.push({ field: "day-1", reason: day1.reason });
      if (blocked.length > 0 || !day1.ok) return bail();
      return { ok: true, body: { frequency, ...anchors, day_1: day1.value } };
    }
    case "Twice per month": {
      const day1 = parseDayOfMonth(opts.day1, frequency, "--day-1");
      const day2 = parseDayOfMonth(opts.day2, frequency, "--day-2");
      if (!day1.ok) blocked.push({ field: "day-1", reason: day1.reason });
      if (!day2.ok) blocked.push({ field: "day-2", reason: day2.reason });
      if (blocked.length > 0 || !day1.ok || !day2.ok) return bail();
      return { ok: true, body: { frequency, ...anchors, day_1: day1.value, day_2: day2.value } };
    }
  }
}

/** A canned `--example` payload for the given (already-resolved) frequency. */
function exampleBody(frequency: PayFrequency | undefined): { body: PayScheduleBody; note: string } {
  if (frequency === "Monthly") {
    return {
      body: { frequency: "Monthly", anchor_pay_date: "2026-07-31", anchor_end_of_pay_period: "2026-07-31", day_1: 31 },
      note: "example: monthly pays once on --day-1; requires --anchor-end-of-pay-period",
    };
  }
  if (frequency === "Twice per month") {
    return {
      body: {
        frequency: "Twice per month",
        anchor_pay_date: "2026-07-15",
        anchor_end_of_pay_period: "2026-07-15",
        day_1: 15,
        day_2: 30,
      },
      note: "example: twice per month pays on --day-1 and --day-2; requires --anchor-end-of-pay-period",
    };
  }
  return {
    body: { frequency: "Every other week", anchor_pay_date: "2026-07-03", anchor_end_of_pay_period: "2026-06-26" },
    note: "example: canonical biweekly shape; all frequencies require --anchor-end-of-pay-period",
  };
}

/** Create-pay-schedule logic, shared by `gusto pay-schedule create` and
 * `gusto company setup pay-schedule` (both command files import it from here, so
 * neither has to reach into the other's module). */
export function payScheduleCreateHandler(opts: PayScheduleCreateOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      const { body, note } = exampleBody(FREQUENCY_MAP[(opts.frequency ?? "").toLowerCase()]);
      return {
        ok: true,
        data: { method: "POST", path: "/v1/companies/{company_uuid}/pay_schedules", body, note },
      };
    }

    const validated = validatePayScheduleCreate(opts);
    if (!validated.ok) return missingArgs(validated.blocked);

    return createCompanyResource(globals, "pay_schedules", validated.body, {
      token: opts.token,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
}
