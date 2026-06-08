import type { Command } from "commander";
import { createCompanyResource, fetchCompanyResource } from "../lib/api-context.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { type CommandHandler, missingArgs, runCommand } from "../lib/runner.ts";

type PayFrequency = "Every week" | "Every other week" | "Twice per month" | "Monthly";

const FREQUENCY_MAP: Record<string, PayFrequency> = {
  weekly: "Every week",
  biweekly: "Every other week",
  "bi-weekly": "Every other week",
  "semi-monthly": "Twice per month",
  semimonthly: "Twice per month",
  monthly: "Monthly",
};

// Week-based schedules are anchored by a pay-period window, so the API requires
// anchor_end_of_pay_period for them. Month-based ones (Twice per month, Monthly)
// are defined by day-of-month instead and don't need it.
const ANCHOR_END_REQUIRED: readonly PayFrequency[] = ["Every week", "Every other week"];

interface PayScheduleBody {
  frequency: PayFrequency;
  anchor_pay_date: string;
  anchor_end_of_pay_period?: string;
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

interface PayScheduleShowOpts {
  companyUuid?: string;
  token?: string;
}

export function registerPayScheduleCommand(parent: Command): void {
  const cmd = parent.command("pay-schedule").description("Create and inspect pay schedules");

  cmd
    .command("create")
    .description("Create a pay schedule (handles Gusto's frequency + date-math rules)")
    .option("--frequency <freq>", `Pay frequency: ${Object.keys(FREQUENCY_MAP).join(", ")}`)
    .option("--first-payday <date>", "First payday (YYYY-MM-DD); the API names this `anchor_pay_date`")
    .option("--anchor-pay-date <date>", "Alias for --first-payday")
    .option("--anchor-end-of-pay-period <date>", "Anchor end-of-period (YYYY-MM-DD)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .option("--dry-run", "Build the request without sending")
    .option("--example", "Print a canned sample payload without calling the API")
    .action((opts: PayScheduleCreateOpts) =>
      runCommand("gusto pay-schedule create", readGlobalFlags(parent.opts()), payScheduleCreateHandler(opts)),
    );

  cmd
    .command("show")
    .description("List active pay schedules for the company")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: PayScheduleShowOpts) =>
      runCommand("gusto pay-schedule show", readGlobalFlags(parent.opts()), payScheduleShowHandler(opts)),
    );
}

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
          },
          note: "example: canonical biweekly shape; --anchor-end-of-pay-period optional",
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
    if (frequency && ANCHOR_END_REQUIRED.includes(frequency) && !opts.anchorEndOfPayPeriod) {
      blocked.push({
        field: "anchor-end-of-pay-period",
        reason: `required for ${frequency.toLowerCase()} schedules (YYYY-MM-DD, end of the first pay period)`,
      });
    }
    if (!frequency || !anchorPayDate || blocked.length > 0) {
      return missingArgs(blocked);
    }

    const body: PayScheduleBody = {
      frequency,
      anchor_pay_date: anchorPayDate,
    };
    if (opts.anchorEndOfPayPeriod) body.anchor_end_of_pay_period = opts.anchorEndOfPayPeriod;

    return createCompanyResource(globals, "pay_schedules", body, {
      token: opts.token,
      companyUuid: opts.companyUuid,
      dryRun: opts.dryRun,
    });
  };
}

function payScheduleShowHandler(opts: PayScheduleShowOpts): CommandHandler {
  return async ({ globals }) =>
    fetchCompanyResource(
      globals,
      { token: opts.token, companyUuid: opts.companyUuid },
      (ctx) => `/v1/companies/${ctx.companyUuid}/pay_schedules`,
    );
}
