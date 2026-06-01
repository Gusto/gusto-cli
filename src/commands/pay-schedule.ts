import type { Command } from "commander";
import { createCompanyResource, resolveApiContext } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { type CommandHandler, runCommand } from "../lib/runner.ts";

type PayFrequency = "Every week" | "Every other week" | "Twice per month" | "Monthly";

const FREQUENCY_MAP: Record<string, PayFrequency> = {
  weekly: "Every week",
  biweekly: "Every other week",
  "bi-weekly": "Every other week",
  "semi-monthly": "Twice per month",
  semimonthly: "Twice per month",
  monthly: "Monthly",
};

interface PayScheduleCreateOpts {
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

function payScheduleCreateHandler(opts: PayScheduleCreateOpts): CommandHandler {
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
    if (blocked.length > 0) {
      return {
        ok: false,
        exitCode: ExitCode.Validation,
        error: { code: "validation", message: "missing required arguments", blocked_on: blocked },
      };
    }

    const body: Record<string, unknown> = {
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
  return async ({ globals }) => {
    const ctx = resolveApiContext(globals, { tokenOverride: opts.token, companyOverride: opts.companyUuid });
    if (!ctx.ok) return ctx.result;

    try {
      const response = await ctx.ctx.client.get(`/v1/companies/${ctx.ctx.companyUuid}/pay_schedules`);
      return { ok: true, data: response.body };
    } catch (err) {
      return toResult(err);
    }
  };
}
