import type { Command } from "commander";
import { ApiError } from "../lib/api-client.ts";
import { withCompanyContext } from "../lib/api-context.ts";
import { errMsg } from "../lib/errors.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { readGlobalFlags } from "../lib/global-flags.ts";
import { toResult } from "../lib/handle-api-error.ts";
import { fetchCompanyLocations } from "../lib/locations.ts";
import { oauthHttp, resolveEnv } from "../lib/oauth/context.ts";
import { type ProvisionResult, provision } from "../lib/oauth/provision.ts";
import { InputError, resolveProvisionPayload } from "../lib/oauth/provision-input.ts";
import { resolveStore } from "../lib/oauth/token-store.ts";
import {
  FINISH_ONBOARDING_ACTION,
  type EmployeeOnboardingInfo,
  type OnboardingStatus,
  type SuggestedAction,
  extractBlockers,
  withExistingEmployeeAction,
  withSignatoryBlocker,
} from "../lib/onboarding-map.ts";
import { type EnrichedPayrollBlocker, enrichPayrollBlockers, fetchPayrollBlockers } from "../lib/payroll-blockers.ts";
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

interface ApproveOpts {
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

  withContextOptions(
    cmd
      .command("approve")
      .description("[DEMO ONLY, non-production] Approve the company so it can run payroll (clears needs_approval)")
      .option("--dry-run", "Describe the request without sending"),
  ).action((opts: ApproveOpts) =>
    runCommand("gusto company approve", readGlobalFlags(parent.opts()), companyApproveHandler(opts)),
  );

  registerCompanySetup(cmd, parent);
  registerCompanyForms(cmd, parent);
}

export function companyLocationsHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      const res = await fetchCompanyLocations(ctx.client, ctx.companyUuid);
      if (!res.ok) return res;
      return { ok: true, data: { locations: res.data } };
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
      ): Promise<
        { ok: true; data: T } | { ok: false; label: string; error: string; status?: number; cause: unknown }
      > => {
        try {
          return { ok: true, data: await fn() };
        } catch (err) {
          const status = err instanceof ApiError ? err.status : undefined;
          return { ok: false, label, error: errMsg(err), status, cause: err };
        }
      };

      const [companyR, paymentR, scheduleR] = await Promise.all([
        safe("company", async () => (await ctx.client.get<CompanyRecord>(base)).body),
        safe("payment_config", async () => (await ctx.client.get<PaymentConfig>(`${base}/payment_configs`)).body),
        safe("pay_schedules", async () => (await ctx.client.get<PaySchedule[]>(`${base}/pay_schedules`)).body),
      ]);

      // The company record is the primary read; if it failed there's nothing to show, so rethrow
      // (mapped to the right exit code downstream) instead of burying it under partial_errors.
      if (!companyR.ok) throw companyR.cause;

      const company = companyR.data;
      const paymentConfig = paymentR.ok ? paymentR.data : null;
      const paySchedules = scheduleR.ok ? scheduleR.data : null;
      const firstSchedule = Array.isArray(paySchedules) ? (paySchedules[0] ?? null) : null;
      // payment_configs is gated on an active PartnerCompanyMapping; non-partner-managed
      // companies (e.g. those reached via `gusto auth login` rather than `provision`) always
      // 404 here, which reads as a bug to anyone watching the output. Drop only the 404 -
      // a 5xx or network error against the same endpoint is still a real failure.
      const suppressPaymentConfig404 = company?.is_partner_managed === false;
      const errors = [paymentR, scheduleR]
        .filter((r): r is { ok: false; label: string; error: string; status?: number; cause: unknown } => !r.ok)
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

/** Map onboarding + payroll-readiness flags to a stage label. `unknown` guards a
 * malformed-but-200 status. The progression is:
 *   unknown -> onboarding -> ready_to_finish -> (finish) -> not_payroll_ready -> done
 * `done` requires BOTH onboarding_completed AND no payroll blockers, so the CLI no
 * longer reports "done" while the company still can't run payroll (AINT-643). A
 * payroll-readiness check that couldn't run (payrollReady null) doesn't fabricate
 * not_payroll_ready - it falls through to done with a partial_error noting the gap. */
function computeStage(s: {
  isComplete: boolean;
  hasSteps: boolean;
  onboardingClear: boolean;
  payrollReady: boolean | null;
}): "done" | "unknown" | "ready_to_finish" | "onboarding" | "not_payroll_ready" {
  if (!s.hasSteps) return "unknown";
  if (!s.onboardingClear) return "onboarding";
  if (!s.isComplete) return "ready_to_finish";
  return s.payrollReady === false ? "not_payroll_ready" : "done";
}

export function companyOnboardingStatusHandler(opts: CompanyShowOpts): CommandHandler {
  return async ({ globals }) =>
    withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      // Onboarding status and payroll blockers are independent reads - fetch in
      // parallel. The payroll-blockers fetch (GET /payrolls/blockers) is the
      // authoritative payroll-readiness signal; a failure is captured so it can
      // degrade to a partial error rather than reject the whole command (AINT-643).
      const [status, payroll] = await Promise.all([
        // Honest type: an empty/malformed body can deserialize to null or {}.
        ctx.client
          .get<OnboardingStatus | null>(`/v1/companies/${ctx.companyUuid}/onboarding_status`)
          .then((r) => r.body),
        fetchPayrollBlockers(ctx.client, ctx.companyUuid).then(
          (blockers) => ({ ok: true as const, blockers }),
          (err) => ({ ok: false as const, error: errMsg(err) }),
        ),
      ]);
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

      // add_employees is backed by the verify_employees step: it clears only when an
      // employee is verified, not merely added. So when an unverified employee already
      // exists, the static "add personal-details" suggestion is wrong - it would create
      // a duplicate. Fetch the roster and let withExistingEmployeeAction rewrite the
      // blocker into a verify note. A failed fetch degrades to a partial error rather
      // than leaving misleading guidance in place.
      let employeesError: string | undefined;
      if (blockedOn.some((b) => b.id === "add_employees")) {
        try {
          const employees =
            (await ctx.client.get<EmployeeOnboardingInfo[] | null>(`/v1/companies/${ctx.companyUuid}/employees`))
              .body ?? [];
          blockedOn = withExistingEmployeeAction(blockedOn, employees);
        } catch (err) {
          employeesError = errMsg(err);
        }
      }

      const isComplete = status?.onboarding_completed === true;
      // A malformed-but-200 response (no onboarding_steps) must not read as
      // "no blockers" -> ready_to_finish; treat a missing step list as unknown.
      const hasSteps = Array.isArray(status?.onboarding_steps);
      const onboardingClear = blockedOn.length === 0;
      const readyToFinish = hasSteps && onboardingClear && !isComplete;

      // Payroll readiness from /payrolls/blockers. The company is payroll-ready iff the
      // raw list is empty; a failed fetch leaves readiness unknown (null). The enriched
      // section dedupes against the open onboarding blockers so it carries only the
      // ADDITIONAL payroll gates (e.g. missing_employee_setup) - the value the onboarding
      // step list doesn't cover.
      const payrollReady = payroll.ok ? payroll.blockers.length === 0 : null;
      const payrollBlockers: EnrichedPayrollBlocker[] = payroll.ok
        ? enrichPayrollBlockers(payroll.blockers, blockedOn)
        : [];

      const stage = computeStage({ isComplete, hasSteps, onboardingClear, payrollReady });

      // next_command sequencing: clear onboarding blockers first, then finish, then drain
      // payroll blockers (the first one with a CLI command; null when only wait-states like
      // needs_approval remain), then nothing once payroll-ready. At ready_to_finish point
      // at the finish verb so the loop doesn't dead-end one step short of done (AINT-615);
      // otherwise use the first blocker that has a command (not just blockedOn[0], whose
      // suggested_action may be null while a later blocker has one).
      let suggested: SuggestedAction | null;
      if (!onboardingClear) {
        suggested = blockedOn.find((b) => b.suggested_action)?.suggested_action ?? null;
      } else if (readyToFinish) {
        suggested = FINISH_ONBOARDING_ACTION;
      } else if (stage === "not_payroll_ready") {
        suggested = payrollBlockers.find((b) => b.suggested_action)?.suggested_action ?? null;
      } else {
        suggested = null;
      }

      const partialErrors: { label: string; error: string }[] = [];
      if (signatoryError) partialErrors.push({ label: "signatories", error: signatoryError });
      if (employeesError) partialErrors.push({ label: "employees", error: employeesError });
      if (!payroll.ok) partialErrors.push({ label: "payroll_blockers", error: payroll.error });

      return {
        ok: true,
        data: {
          stage,
          company_uuid: ctx.companyUuid,
          blocked_on: blockedOn,
          ready_to_finish: readyToFinish,
          payroll_ready: payrollReady,
          payroll_blockers: payrollBlockers,
          suggested_action: suggested,
          next_command: suggested?.command ?? null,
          onboarding_status: status,
          ...(partialErrors.length > 0 ? { partial_errors: partialErrors } : {}),
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

interface ApproveResult {
  company_status?: string;
}

export function companyApproveHandler(opts: ApproveOpts): CommandHandler {
  return async ({ globals }) => {
    // Demo-only escape hatch: approving server-side bypasses Gusto's underwriting/
    // review. Never allow it against production - there, approval is an out-of-band
    // Gusto process, not a CLI action. Mirrors the `company forms --demo-sign` guard.
    if (globals.env === "production") {
      return {
        ok: false,
        exitCode: ExitCode.Blocked,
        error: {
          code: "demo_only",
          message:
            "`gusto company approve` is a non-production demo escape hatch. In production a company is approved by Gusto's review, not the CLI.",
        },
      };
    }

    if (opts.dryRun) {
      return {
        ok: true,
        data: {
          steps: [{ method: "PUT", path: "/v1/companies/{company_uuid}/approve" }],
          note: "[DEMO ONLY] approve clears the needs_approval payroll blocker and generates the company's draft payrolls",
        },
      };
    }

    return withCompanyContext(globals, { tokenStdin: opts.tokenStdin, companyUuid: opts.companyUuid }, async (ctx) => {
      // A 422 means the API rejected the approval (e.g. a prerequisite is unmet);
      // toResult surfaces the upstream body so the agent sees why rather than a bare
      // "422". A 200 can still carry an empty/malformed body (null), so the read
      // below is null-safe - the same malformed-but-200 discipline `finish` uses.
      let approved: ApproveResult | null;
      try {
        approved = (await ctx.client.put<ApproveResult | null>(`/v1/companies/${ctx.companyUuid}/approve`)).body;
      } catch (err) {
        return toResult(err);
      }

      // A 200 doesn't guarantee the status flipped: the body can be empty/malformed
      // (null). Only claim approval when company_status actually reads "Approved";
      // otherwise report accepted-but-unconfirmed so an agent doesn't tell the user
      // the company is approved when the API never said so.
      const status = approved?.company_status ?? null;
      const approvedOk = status === "Approved";
      return {
        ok: true,
        data: {
          company_status: status,
          company: approved,
          message: approvedOk
            ? "Company approved (company_status -> Approved). Draft payrolls will be generated - re-check with `gusto company onboarding-status`."
            : "approve accepted, but company_status isn't confirmed yet - re-check with `gusto company onboarding-status`.",
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

    if (opts.example) {
      return {
        ok: true,
        data: {
          method: "POST",
          path: "/v1/provision",
          body: payload,
          note: "example: a sample {user, company} payload; email + EIN are randomized so this stays runnable as --input",
        },
      };
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
