import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { withCompanyContext } from "../lib/api-context.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { companyUuidFromTokenInfo, defaultOpenBrowser } from "../lib/oauth/login.ts";
import { type ProvisionResult, provision } from "../lib/oauth/provision.ts";
import { InputError, resolveProvisionPayload } from "../lib/oauth/provision-input.ts";
import { resolveStore } from "../lib/oauth/token-store.ts";
import { type OnboardingStatus, extractBlockers } from "../lib/onboarding-map.ts";
import { type CommandHandler, type CommandResult, runCommand } from "../lib/runner.ts";
import { registerCompanyForms, registerCompanySetup } from "./company-setup.ts";

interface CompanyShowOpts {
  companyUuid?: string;
  token?: string;
}

interface ProvisionOpts {
  input?: string;
  example?: boolean;
  dryRun?: boolean;
}

export function registerCompanyCommand(parent: Command): void {
  const cmd = parent.command("company").description("Provision, inspect, and onboard a company");

  cmd
    .command("provision")
    .description("Create a Gusto company programmatically (the wedge command)")
    .option("--input <file>", "Path to a JSON file with the {user, company} payload")
    .option("--example", "Use the canned sample payload")
    .option("--dry-run", "Build the request without sending")
    .action((opts: ProvisionOpts) =>
      runCommand("gusto company provision", readGlobalFlags(parent.opts()), companyProvisionHandler(opts)),
    );

  cmd
    .command("onboarding-status")
    .description("Onboarding state + structured blocked_on list (the agent's navigation hook)")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: CompanyShowOpts) =>
      runCommand(
        "gusto company onboarding-status",
        readGlobalFlags(parent.opts()),
        companyOnboardingStatusHandler(opts),
      ),
    );

  cmd
    .command("show")
    .description("Company overview: record, payment config, and pay schedule")
    .option("--company-uuid <uuid>", "Company UUID (overrides GUSTO_COMPANY_UUID)")
    .option("--token <token>", "Access token (overrides GUSTO_ACCESS_TOKEN)")
    .action((opts: CompanyShowOpts) =>
      runCommand("gusto company show", readGlobalFlags(parent.opts()), companyShowHandler(opts)),
    );

  registerCompanySetup(cmd, parent);
  registerCompanyForms(cmd, parent);
}

interface CompanyRecord {
  name?: string;
  trade_name?: string;
  company_status?: string;
  tier?: string;
  ein?: string;
  entity_type?: string;
}
interface PaymentConfig {
  payment_speed?: string;
  fast_payment_limit?: unknown;
}
interface PaySchedule {
  uuid?: string;
  frequency?: string;
  anchor_pay_date?: string;
  anchor_end_of_pay_period?: string;
}

export function companyShowHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}`;
      const safe = async <T>(
        label: string,
        fn: () => Promise<T>,
      ): Promise<{ ok: true; data: T } | { ok: false; label: string; error: string }> => {
        try {
          return { ok: true, data: await fn() };
        } catch (err) {
          return { ok: false, label, error: err instanceof Error ? err.message : String(err) };
        }
      };

      const [companyR, paymentR, scheduleR] = await Promise.all([
        safe("company", async () => (await ctx.client.get<CompanyRecord>(base)).body),
        safe("payment_config", async () => (await ctx.client.get<PaymentConfig>(`${base}/payment_configs`)).body),
        safe("pay_schedules", async () => (await ctx.client.get<PaySchedule[]>(`${base}/pay_schedules`)).body),
      ]);

      const company = companyR.ok ? companyR.data : null;
      const paymentConfig = paymentR.ok ? paymentR.data : null;
      const paySchedules = scheduleR.ok ? scheduleR.data : null;
      const firstSchedule = Array.isArray(paySchedules) ? (paySchedules[0] ?? null) : null;
      const errors = [companyR, paymentR, scheduleR].filter((r) => !r.ok);

      return {
        ok: true,
        data: {
          success: errors.length === 0,
          company_uuid: ctx.companyUuid,
          summary: {
            name: company?.name ?? null,
            trade_name: company?.trade_name ?? null,
            status: company?.company_status ?? null,
            tier: company?.tier ?? null,
            ein: company?.ein ?? null,
            entity_type: company?.entity_type ?? null,
            payment_speed: paymentConfig?.payment_speed ?? null,
            pay_schedule: firstSchedule
              ? { frequency: firstSchedule.frequency, anchor_pay_date: firstSchedule.anchor_pay_date }
              : null,
          },
          company,
          payment_config: paymentConfig,
          pay_schedules: paySchedules,
          ...(errors.length > 0 ? { partial_errors: errors } : {}),
        },
      };
    });
}

export function companyOnboardingStatusHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      const status = (await ctx.client.get<OnboardingStatus>(`/v1/companies/${ctx.companyUuid}/onboarding_status`))
        .body;
      const blockedOn = extractBlockers(status);
      const isComplete = status?.onboarding_completed === true;
      const readyToFinish = blockedOn.length === 0 && !isComplete;
      const stage = isComplete ? "done" : readyToFinish ? "ready_to_finish" : "onboarding";
      const suggested = blockedOn[0]?.suggested_action ?? null;
      return {
        ok: true,
        data: {
          stage,
          company_uuid: ctx.companyUuid,
          blocked_on: blockedOn,
          ready_to_finish: readyToFinish,
          suggested_action: suggested,
          next_command: suggested?.command ?? null,
          onboarding_status: status,
        },
      };
    });
}

export interface ProvisionData {
  account_claim_url: string;
  company_uuid: string | null;
}

export function provisionResultData(result: ProvisionResult): ProvisionData {
  return {
    account_claim_url: result.accountClaimUrl,
    company_uuid: companyUuidFromTokenInfo(result.tokenInfo) ?? null,
  };
}

/** Map a payload-resolution failure: bad input is a validation error, anything else flows through toResult. */
export function provisionPayloadError(err: unknown): CommandResult<never> {
  if (err instanceof InputError) {
    return { ok: false, exitCode: ExitCode.Validation, error: { code: "invalid_input", message: err.message } };
  }
  return toResult(err);
}

export const NOT_INTERACTIVE: CommandResult<never> = {
  ok: false,
  exitCode: ExitCode.General,
  error: {
    code: "not_interactive",
    message:
      "`gusto company provision` is interactive - it opens a browser and waits for you to claim the account. Run it in a terminal, or use --dry-run to preview the request.",
  },
};

export function companyProvisionHandler(opts: ProvisionOpts): CommandHandler {
  return async ({ globals }) => {
    let payload;
    try {
      payload = await resolveProvisionPayload({ input: opts.input, example: opts.example }, (p) => Bun.file(p).text());
    } catch (err) {
      return provisionPayloadError(err);
    }

    if (opts.dryRun) {
      return { ok: true, data: { method: "POST", path: "/v1/provision", body: payload } };
    }
    if (!process.stdin.isTTY) return NOT_INTERACTIVE;

    try {
      const result = await provision(resolveEnv(globals), payload, {
        store: resolveStore(),
        http: oauthHttp(globals),
        openBrowser: defaultOpenBrowser,
        confirmClaim: waitForEnter,
      });
      return { ok: true, data: provisionResultData(result) };
    } catch (err) {
      return toResult(err);
    }
  };
}

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await rl.question("Press Enter once you've finished claiming the account in your browser...");
  } catch {
    // stdin closed/EOF before Enter (disconnected TTY etc.) - treat as continue rather than hang.
  } finally {
    rl.close();
  }
}
