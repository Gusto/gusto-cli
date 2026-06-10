import { createCompanyResource } from "./api-context.ts";
import { type CommandHandler, missingArgs } from "./runner.ts";

export type PayFrequency = "Every week" | "Every other week";

// V1 supports weekly + biweekly only. Twice-per-month and Monthly need extra
// fields (`day_1`, `day_2`, plus anchor_end_of_pay_period for all frequencies)
// that the CLI doesn't model; AINT-606 tracks adding them.
export const FREQUENCY_MAP: Record<string, PayFrequency> = {
  weekly: "Every week",
  biweekly: "Every other week",
  "bi-weekly": "Every other week",
};

interface PayScheduleBody {
  frequency: PayFrequency;
  anchor_pay_date: string;
  anchor_end_of_pay_period: string;
}

export interface PayScheduleCreateOpts {
  frequency?: string;
  firstPayday?: string;
  anchorPayDate?: string;
  anchorEndOfPayPeriod?: string;
  companyUuid?: string;
  token?: string;
  dryRun?: boolean;
  example?: boolean;
}

/** Create-pay-schedule logic, shared by `gusto pay-schedule create` and
 * `gusto company setup pay-schedule` (both command files import it from here, so
 * neither has to reach into the other's module). */
export function payScheduleCreateHandler(opts: PayScheduleCreateOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/companies/{company_uuid}/pay_schedules",
          body: {
            frequency: "Every other week",
            anchor_pay_date: "2026-07-03",
            anchor_end_of_pay_period: "2026-06-26",
          },
          note: "example: canonical biweekly shape; weekly/biweekly require --anchor-end-of-pay-period",
        },
      };
    }

    const frequency = FREQUENCY_MAP[(opts.frequency ?? "").toLowerCase()];
    const anchorPayDate = opts.anchorPayDate ?? opts.firstPayday;

    const blocked = [];
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
    const anchorEnd = opts.anchorEndOfPayPeriod;
    if (frequency && !anchorEnd) {
      blocked.push({
        field: "anchor-end-of-pay-period",
        reason: `required for ${frequency.toLowerCase()} schedules (YYYY-MM-DD, end of the first pay period)`,
      });
    }
    if (!frequency || !anchorPayDate || !anchorEnd || blocked.length > 0) {
      return missingArgs(blocked);
    }

    const body: PayScheduleBody = {
      frequency,
      anchor_pay_date: anchorPayDate,
      anchor_end_of_pay_period: anchorEnd,
    };

    return createCompanyResource(globals, "pay_schedules", body, {
      token: opts.token,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
}
