/**
 * Payroll-readiness blockers, surfaced by `gusto company onboarding-status`
 * alongside the company-onboarding `blocked_on` list. Company onboarding
 * (taxes, bank, pay schedule, forms) completing is NOT the same as the company
 * being able to run payroll: gusto.com gates payroll on additional setup
 * (employee personal details, bank verification) and post-onboarding review
 * (approval). The dedicated GET /v1/companies/{uuid}/payrolls/blockers endpoint
 * is the authoritative readiness signal - an empty list means payroll-ready.
 *
 * Blocker keys come from the Payroll-Blocker schema's `key` enum. Where a blocker
 * maps to a CLI command we reuse the same onboarding step ids (and thus the same
 * command + flag definitions) from onboarding-map, so there is a single source of
 * truth for "which command resolves this". Keys with no CLI equivalent (wait-states
 * like `needs_approval`, infra errors like `eftps_in_error`) surface with a null
 * suggested_action: the agent shows the API message and waits.
 */

import type { ReadClient } from "./api-client.ts";
import { SIGNATORY_STEP_ID, type Blocker, type SuggestedAction, suggestedActionFor } from "./onboarding-map.ts";

/** A payroll blocker as returned by GET /v1/companies/{uuid}/payrolls/blockers. */
export interface PayrollBlocker {
  key: string;
  message: string;
}

/** A payroll blocker enriched with the CLI command that resolves it (or null). */
export interface EnrichedPayrollBlocker {
  key: string;
  message: string;
  suggested_action: SuggestedAction | null;
}

/** Maps a payroll blocker `key` to the onboarding step id whose command resolves it.
 * Several keys share a command: both signatory blockers point at the signatory step,
 * both pay-schedule blockers at the pay-schedule step, and a missing/unverified bank
 * both resolve through the one compound bank-account command.
 *
 * `needs_onboarding` is deliberately absent - it's resolved by the onboarding flow
 * this very command drives, so it's dropped rather than mapped (see enrichPayrollBlockers).
 * Keys absent here (needs_approval, pending_*, suspended, eftps_in_error, geocode_*,
 * company_ownership_required, contractor_only_company) have no CLI command and surface
 * with a null suggested_action. */
const BLOCKER_KEY_TO_STEP: Record<string, string> = {
  missing_addresses: "add_addresses",
  missing_industry_selection: "select_industry",
  missing_federal_tax_setup: "federal_tax_setup",
  missing_bank_info: "add_bank_info",
  missing_bank_verification: "verify_bank_info",
  missing_state_tax_setup: "state_setup",
  missing_pay_schedule: "payroll_schedule",
  pay_schedule_setup_not_complete: "payroll_schedule",
  missing_forms: "sign_all_forms",
  missing_signatory: SIGNATORY_STEP_ID,
  invalid_signatory: SIGNATORY_STEP_ID,
  missing_employee_setup: "add_employees",
};

/** The CLI command (with flags) that resolves a payroll blocker key, or null when
 * no CLI command applies (wait-states and infra errors). */
export function payrollBlockerAction(key: string): SuggestedAction | null {
  const step = BLOCKER_KEY_TO_STEP[key];
  return step ? suggestedActionFor(step) : null;
}

/** Normalize an arbitrary value into a PayrollBlocker, or null if it can't be one.
 * Element validation lives here (and only here) so fetchPayrollBlockers returns a genuine
 * PayrollBlocker[] and downstream consumers can trust the type without re-checking it.
 *
 * A string `key` is required - it's the blocker's identity and what maps to a resolving
 * command, so a key-less value is unusable and dropped. `message` is only descriptive, so a
 * missing/non-string message is normalized to "" rather than dropping the blocker: dropping a
 * still-identifiable blocker would shrink the list and could flip the company to a false
 * `payroll_ready: true`, the very failure this feature exists to prevent. */
function toPayrollBlocker(value: unknown): PayrollBlocker | null {
  if (typeof value !== "object" || value === null) return null;
  const { key, message } = value as Record<string, unknown>;
  if (typeof key !== "string") return null;
  return { key, message: typeof message === "string" ? message : "" };
}

/** Enrich payroll blockers with their resolving command, then dedupe against the
 * company-onboarding blockers so the agent isn't told the same thing twice:
 *
 * - `needs_onboarding` is dropped - it's the onboarding flow that onboarding-status
 *   already drives via `blocked_on`, so re-listing it as a payroll blocker is noise.
 * - A payroll blocker whose resolving command is already an OPEN onboarding blocker is
 *   dropped (e.g. while `federal_tax_setup` is still in blocked_on, the mirrored
 *   `missing_federal_tax_setup` is redundant). Once an onboarding step reads complete
 *   its command leaves blocked_on, so a payroll gate that outlives it (e.g.
 *   `missing_bank_verification` after the bank step "completes") still surfaces here.
 * - Blockers with no CLI command can never collide with an onboarding step, so they
 *   always surface (with a null suggested_action).
 *
 * Input is trusted to be well-formed PayrollBlocker[] - fetchPayrollBlockers validates
 * element shape, so there are no defensive type checks here. */
export function enrichPayrollBlockers(raw: PayrollBlocker[], onboardingBlockers: Blocker[]): EnrichedPayrollBlocker[] {
  const openCommands = new Set(
    onboardingBlockers.map((b) => b.suggested_action?.command).filter((c): c is string => typeof c === "string"),
  );
  return raw
    .filter((b) => b.key !== "needs_onboarding")
    .map((b) => ({ key: b.key, message: b.message, suggested_action: payrollBlockerAction(b.key) }))
    .filter((b) => b.suggested_action === null || !openCommands.has(b.suggested_action.command));
}

/** GET the company's payroll blockers. An empty list means the company is payroll-ready.
 *
 * The endpoint's contract is a (possibly empty) JSON array of blockers. A non-array body
 * is malformed and we cannot conclude readiness from it, so it throws rather than coercing
 * to `[]`: coercing would report `payroll_ready: true` off an error envelope, the inverse
 * of the malformed-but-200 discipline onboarding_status uses (a malformed body is "unknown",
 * never silently "no blockers"). The caller degrades a throw to a partial error with
 * readiness left unknown (null). Within the array, each element is normalized to a
 * PayrollBlocker (key-less values dropped, missing messages defaulted) so the returned
 * PayrollBlocker[] is honest. Also throws on a failed GET. */
export async function fetchPayrollBlockers(client: ReadClient, companyUuid: string): Promise<PayrollBlocker[]> {
  const body = (await client.get<unknown>(`/v1/companies/${companyUuid}/payrolls/blockers`)).body;
  if (!Array.isArray(body)) {
    throw new Error(`payroll blockers response was not an array (got ${body === null ? "null" : typeof body})`);
  }
  return body.map(toPayrollBlocker).filter((b): b is PayrollBlocker => b !== null);
}
