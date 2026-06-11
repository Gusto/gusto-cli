import type { Command } from "commander";
import { ApiError } from "../lib/api-client.ts";
import { withCompanyContext } from "../lib/api-context.ts";
import { errMsg } from "../lib/errors.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { type ProvisionResult, provision } from "../lib/oauth/provision.ts";
import { InputError, resolveProvisionPayload } from "../lib/oauth/provision-input.ts";
import { resolveStore } from "../lib/oauth/token-store.ts";
import { type OnboardingStatus, extractBlockers, withSignatoryBlocker } from "../lib/onboarding-map.ts";
import { companyHasSignatory } from "../lib/signatory.ts";
import { type CommandHandler, type CommandResult, runCommand, runReadCommand } from "../lib/runner.ts";
import { registerCompanyForms, registerCompanySetup, withContextOptions } from "./company-setup.ts";

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
    .description("Create a new Gusto company and get an account claim URL")
    .option("--input <file>", "Path to a JSON file with the {user, company} payload")
    .option("--example", "Use the canned sample payload")
    .option("--dry-run", "Build the request without sending")
    .action((opts: ProvisionOpts) =>
      runCommand("gusto company provision", readGlobalFlags(parent.opts()), companyProvisionHandler(opts)),
    );

  withContextOptions(
    cmd
      .command("onboarding-status")
      .description("Onboarding state + structured blocked_on list (the agent's navigation hook)"),
  ).action((opts: CompanyShowOpts) =>
    runReadCommand(
      "gusto company onboarding-status",
      readGlobalFlags(parent.opts()),
      companyOnboardingStatusHandler(opts),
    ),
  );

  withContextOptions(
    cmd.command("show").description("Company overview: record, payment config, and pay schedule"),
  ).action((opts: CompanyShowOpts) =>
    runReadCommand("gusto company show", readGlobalFlags(parent.opts()), companyShowHandler(opts)),
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
  is_partner_managed?: boolean;
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
      ): Promise<{ ok: true; data: T } | { ok: false; label: string; error: string; status?: number }> => {
        try {
          return { ok: true, data: await fn() };
        } catch (err) {
          const status = err instanceof ApiError ? err.status : undefined;
          return { ok: false, label, error: errMsg(err), status };
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
      // payment_configs is gated on an active PartnerCompanyMapping; non-partner-managed
      // companies (e.g. those reached via `gusto auth login` rather than `provision`) always
      // 404 here, which reads as a bug to anyone watching the output. Drop only the 404 -
      // a 5xx or network error against the same endpoint is still a real failure.
      const suppressPaymentConfig404 = company?.is_partner_managed === false;
      const errors = [companyR, paymentR, scheduleR]
        .filter((r): r is { ok: false; label: string; error: string; status?: number } => !r.ok)
        .filter((r) => !(r.label === "payment_config" && r.status === 404 && suppressPaymentConfig404))
        .map(({ label, error }) => ({ label, error }));

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

/** Map onboarding flags to a stage label. `unknown` guards a malformed-but-200 status. */
function onboardingStage(s: {
  isComplete: boolean;
  hasSteps: boolean;
  readyToFinish: boolean;
}): "done" | "unknown" | "ready_to_finish" | "onboarding" {
  if (s.isComplete) return "done";
  if (!s.hasSteps) return "unknown";
  return s.readyToFinish ? "ready_to_finish" : "onboarding";
}

export function companyOnboardingStatusHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    withCompanyContext(globals, { token: opts.token, companyUuid: opts.companyUuid }, async (ctx) => {
      // Honest type: an empty/malformed body can deserialize to null or {}.
      const status = (
        await ctx.client.get<OnboardingStatus | null>(`/v1/companies/${ctx.companyUuid}/onboarding_status`)
      ).body;
      const apiBlockers = extractBlockers(status);

      // The API's onboarding_status never lists a signatory step, yet form signing
      // needs a signatory to exist first. When sign_all_forms is still pending,
      // check for a signatory and inject a synthetic blocker ahead of it so the
      // agent assigns one before being sent into the signing flow. A failed check
      // is recorded as a partial error rather than fabricating a (possibly false)
      // blocker that could wedge the loop forever.
      let blockedOn = apiBlockers;
      let signatoryError: string | undefined;
      if (apiBlockers.some((b) => b.id === "sign_all_forms")) {
        try {
          const hasSignatory = await companyHasSignatory(ctx.client, ctx.companyUuid);
          blockedOn = withSignatoryBlocker(apiBlockers, hasSignatory);
        } catch (err) {
          signatoryError = errMsg(err);
        }
      }

      const isComplete = status?.onboarding_completed === true;
      // A malformed-but-200 response (no onboarding_steps) must not read as
      // "no blockers" -> ready_to_finish; treat a missing step list as unknown.
      const hasSteps = Array.isArray(status?.onboarding_steps);
      const readyToFinish = hasSteps && blockedOn.length === 0 && !isComplete;
      const stage = onboardingStage({ isComplete, hasSteps, readyToFinish });
      // First blocker that actually has a command - not just blockedOn[0], whose
      // suggested_action may be null while a later blocker has one.
      const suggested = blockedOn.find((b) => b.suggested_action)?.suggested_action ?? null;
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
          ...(signatoryError ? { partial_errors: [{ label: "signatories", error: signatoryError }] } : {}),
        },
      };
    });
}

export interface ProvisionData {
  account_claim_url: string;
  next_command: string;
  next_step: string;
}

// provision no longer logs in, so there's no company UUID to return yet - it
// comes from the Mode 2 token that `gusto auth login` mints after the claim.
export function provisionResultData(result: ProvisionResult): ProvisionData {
  return {
    account_claim_url: result.accountClaimUrl,
    next_command: "gusto auth login",
    next_step: "Claim the account in your browser, then run `gusto auth login` to authenticate.",
  };
}

/** Map a payload-resolution failure: bad input is a validation error, anything else flows through toResult. */
export function provisionPayloadError(err: unknown): CommandResult<never> {
  if (err instanceof InputError) {
    return { ok: false, exitCode: ExitCode.Validation, error: { code: "invalid_input", message: err.message } };
  }
  return toResult(err);
}

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

    try {
      const result = await provision(resolveEnv(globals), payload, {
        store: resolveStore(),
        http: oauthHttp(globals),
      });
      return { ok: true, data: provisionResultData(result) };
    } catch (err) {
      return toResult(err);
    }
  };
}
