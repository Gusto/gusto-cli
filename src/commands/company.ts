import type { Command } from "commander";
import { ApiError } from "../lib/api-client.ts";
import { withCompanyContext } from "../lib/api-context.ts";
import { errMsg } from "../lib/errors.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { MalformedLocationsBodyError, fetchCompanyLocations, malformedLocationsResult } from "../lib/locations.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { type ProvisionResult, provision } from "../lib/oauth/provision.ts";
import { InputError, resolveProvisionPayload } from "../lib/oauth/provision-input.ts";
import { resolveStore } from "../lib/oauth/token-store.ts";
import {
  FINISH_ONBOARDING_ACTION,
  type OnboardingStatus,
  extractBlockers,
  withSignatoryBlocker,
} from "../lib/onboarding-map.ts";
import { companyHasSignatory } from "../lib/signatory.ts";
import { type CommandHandler, type CommandResult, missingArgs, runCommand, runReadCommand } from "../lib/runner.ts";
import { registerCompanyForms, registerCompanySetup, withContextOptions } from "./company-setup.ts";

interface CompanyShowOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
}

interface ProvisionOpts {
  input?: string;
  example?: boolean;
  dryRun?: boolean;
}

interface FinishOnboardingOpts {
  companyUuid?: string;
  tokenStdin?: boolean;
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

  withContextOptions(
    cmd
      .command("locations")
      .description("List the company's locations (employee work addresses reference these by uuid)"),
  ).action((opts: CompanyShowOpts) =>
    runReadCommand("gusto company locations", readGlobalFlags(parent.opts()), companyLocationsHandler(opts)),
  );

  withContextOptions(
    cmd
      .command("finish")
      .description("Finalize onboarding (flips onboarding_completed -> true)")
      .option("--dry-run", "Describe the request without sending"),
  ).action((opts: FinishOnboardingOpts) =>
    runCommand("gusto company finish", readGlobalFlags(parent.opts()), companyFinishOnboardingHandler(opts)),
  );

  registerCompanySetup(cmd, parent);
  registerCompanyForms(cmd, parent);
}

export function companyLocationsHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      try {
        const locations = await fetchCompanyLocations(ctx.client, ctx.companyUuid);
        return { ok: true, data: { locations } };
      } catch (err) {
        if (err instanceof MalformedLocationsBodyError) return malformedLocationsResult(err);
        throw err;
      }
    });
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
    withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
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
    withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
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
      // At ready_to_finish there are no blockers left, so point the agent at the
      // finish command — otherwise next_command is null and the loop dead-ends one
      // step short of done (AINT-615). Otherwise use the first blocker that has a
      // command (not just blockedOn[0], whose suggested_action may be null while a
      // later blocker has one).
      const suggested = readyToFinish
        ? FINISH_ONBOARDING_ACTION
        : (blockedOn.find((b) => b.suggested_action)?.suggested_action ?? null);
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

interface FinishOnboardingResult {
  onboarding_completed?: boolean;
}

export function companyFinishOnboardingHandler(opts: FinishOnboardingOpts): CommandHandler {
  return async ({ globals }) => {
    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          steps: [{ method: "PUT", path: "/v1/companies/{company_uuid}/finish_onboarding" }],
          note: "finish_onboarding flips onboarding_completed -> true (stage 'done')",
        },
      };
    }

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const base = `/v1/companies/${ctx.companyUuid}`;

      // finish_onboarding flips onboarding_completed -> true (stage 'done'). A 422
      // here means the API considers a required step unsatisfied; toResult surfaces
      // the upstream body so the agent sees which one rather than a bare "422".
      // A 200 can still carry an empty/malformed body (deserializes to null), so the
      // read below is null-safe - the same malformed-but-200 discipline the
      // onboarding-status and bank-account handlers use. Without it, a null body
      // would throw a TypeError past the try and surface as an opaque
      // internal_error (exit 1) instead of a structured result.
      let onboarding: FinishOnboardingResult | null;
      try {
        onboarding = (await ctx.client.put<FinishOnboardingResult | null>(`${base}/finish_onboarding`)).body;
      } catch (err) {
        return toResult(err);
      }

      // A 200 doesn't guarantee the flag flipped: the body can be empty/malformed (null) or the API
      // can accept the request and complete onboarding asynchronously (onboarding_completed false).
      // Only claim completion when the flag actually reads true; otherwise report it as accepted-but-
      // unconfirmed so an agent doesn't tell the user onboarding is done when the API never said so.
      const completed = onboarding?.onboarding_completed === true;
      return {
        ok: true,
        data: {
          onboarding_completed: onboarding?.onboarding_completed ?? null,
          finish_onboarding: onboarding,
          message: completed
            ? "Onboarding finished (onboarding_completed -> true)."
            : "finish_onboarding accepted, but onboarding_completed isn't confirmed yet - re-check with `gusto company onboarding-status`.",
        },
      };
    });
  };
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
    if (!opts.input && !opts.example) {
      return missingArgs([
        {
          field: "input",
          reason: "provide --input <file.json> with a {user, company} payload, or --example for a sample run",
        },
      ]);
    }

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
