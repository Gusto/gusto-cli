/**
 * Maps a Gusto onboarding step id to the CLI command that resolves it, so
 * `gusto company onboarding-status` can hand an agent an actionable next step
 * per blocker. Step ids come from /v1/companies/{uuid}/onboarding_status's
 * `onboarding_steps[].id`. Unmapped steps return a null suggested_action -
 * the blocker is still surfaced, just without a command guess.
 */

export interface SuggestedAction {
  command: string;
  required_flags: string[];
  optional_flags: string[];
  source: "cli_static_map";
}

interface MapEntry {
  command: string;
  required_flags: string[];
  optional_flags: string[];
}

/** Step id for the signatory assignment blocker. Synthetic: the API's
 * onboarding_status doesn't surface it, so the CLI injects it. */
export const SIGNATORY_STEP_ID = "assign_signatory";

// add_bank_info and verify_bank_info are both resolved by the one compound
// connect command (create + test deposits + verify), so they share an entry.
const BANK_CONNECT: MapEntry = {
  command: "gusto company setup bank-account",
  required_flags: ["--routing", "--account-number", "--account-type"],
  optional_flags: [],
};

const BLOCKER_TO_COMMAND: Record<string, MapEntry> = {
  add_addresses: {
    command: "gusto company setup address",
    required_flags: ["--street-1", "--city", "--state", "--zip", "--phone"],
    // The primary location defaults to the filing + mailing address; --no-* opt out.
    optional_flags: ["--street-2", "--country", "--no-filing-address", "--no-mailing-address"],
  },
  select_industry: {
    command: "gusto company setup industry",
    required_flags: ["--naics-code"],
    optional_flags: ["--title", "--sic-code"],
  },
  federal_tax_setup: {
    command: "gusto company setup federal-tax",
    required_flags: ["--ein", "--tax-payer-type", "--filing-form", "--legal-name"],
    optional_flags: ["--taxable-as-scorp"],
  },
  add_bank_info: BANK_CONNECT,
  verify_bank_info: BANK_CONNECT,
  state_setup: {
    command: "gusto company setup state-tax",
    required_flags: [],
    optional_flags: ["--no-temporary-rates"],
  },
  payroll_schedule: {
    command: "gusto company setup pay-schedule",
    required_flags: ["--frequency", "--first-payday"],
    // --anchor-end-of-pay-period is also required for weekly/biweekly (enforced in pay-schedule.ts).
    optional_flags: ["--anchor-end-of-pay-period"],
  },
  sign_all_forms: {
    command: "gusto company forms",
    required_flags: [],
    // Deliberately NOT advertising --demo-sign: agents should use the hosted
    // signing flow (the legally-defensible path), not the demo escape hatch.
    optional_flags: ["--note"],
  },
  // Synthetic step (no matching API onboarding_step). The signatory must exist
  // before form signing is meaningful — the hosted flow signs on behalf of the
  // signatory — but the API's onboarding_status never lists it. We inject it
  // ahead of sign_all_forms so an agent assigns the signatory first. See
  // withSignatoryBlocker and SIGNATORY_STEP_ID.
  [SIGNATORY_STEP_ID]: {
    command: "gusto company setup signatory",
    required_flags: ["--first-name", "--last-name", "--email"],
    optional_flags: ["--title"],
  },
  add_employees: {
    command: "gusto employee add personal-details",
    required_flags: ["--first-name", "--last-name", "--email"],
    optional_flags: ["--admin-driven", "--ssn", "--date-of-birth", "--company-uuid"],
  },
};

/** The action that completes onboarding once every required step is satisfied.
 * It's the navigation hook at stage `ready_to_finish`, where `blocked_on` is
 * empty so there's no per-blocker suggestion — without it an agent following
 * `next_command` dead-ends one step short of done (AINT-615). */
export const FINISH_ONBOARDING_ACTION: SuggestedAction = {
  command: "gusto company finish",
  required_flags: [],
  optional_flags: [],
  source: "cli_static_map",
};

export function suggestedActionFor(stepId: string): SuggestedAction | null {
  const entry = BLOCKER_TO_COMMAND[stepId];
  if (!entry) return null;
  return {
    command: entry.command,
    required_flags: entry.required_flags,
    optional_flags: entry.optional_flags,
    source: "cli_static_map",
  };
}

export interface OnboardingStep {
  id: string;
  title?: string;
  required?: boolean;
  completed?: boolean;
  requirements?: unknown[];
}

export interface OnboardingStatus {
  onboarding_steps?: OnboardingStep[];
  onboarding_completed?: boolean;
}

export interface Blocker {
  id: string;
  title?: string;
  requirements: unknown[];
  suggested_action: SuggestedAction | null;
  /** Explanation attached when the static suggested_action would mislead (e.g. add_employees needs a verified employee). */
  note?: string;
}

/** Required-and-incomplete onboarding steps, each enriched with the CLI command
 * that resolves it. */
export function extractBlockers(status: OnboardingStatus | null | undefined): Blocker[] {
  const steps = status?.onboarding_steps ?? [];
  return steps
    .filter((s) => s.required === true && s.completed !== true)
    .map((s) => ({
      id: s.id,
      title: s.title,
      requirements: s.requirements ?? [],
      suggested_action: suggestedActionFor(s.id),
    }));
}

/** Inject the synthetic signatory blocker when forms still need signing and no
 * signatory is assigned yet. It's placed immediately before `sign_all_forms` so
 * it gates signing in the agent's `next_command` loop — the same shape as a real
 * blocker, with a `suggested_action` pointing at `gusto company setup signatory`.
 *
 * No-op when a signatory exists, or when `sign_all_forms` isn't an active blocker
 * (forms already signed, or not yet surfaced): the signatory only matters as a
 * precondition for signing, so there's nothing to gate otherwise. */
export function withSignatoryBlocker(blockers: Blocker[], hasSignatory: boolean): Blocker[] {
  if (hasSignatory) return blockers;
  const signIdx = blockers.findIndex((b) => b.id === "sign_all_forms");
  if (signIdx === -1) return blockers;
  const signatory: Blocker = {
    id: SIGNATORY_STEP_ID,
    title: "Assign a signatory",
    requirements: [],
    suggested_action: suggestedActionFor(SIGNATORY_STEP_ID),
  };
  return [...blockers.slice(0, signIdx), signatory, ...blockers.slice(signIdx)];
}

/** Minimal employee shape the onboarding-status handler reads to tailor add_employees guidance. */
export interface EmployeeOnboardingInfo {
  onboarding_status?: string;
  terminated?: boolean;
}

/** onboarding_status once an employee is fully verified; add_employees (verify_employees) clears only then. */
const EMPLOYEE_VERIFIED_STATUS = "onboarding_completed";

/** When an unverified employee already exists, add_employees needs a verified employee (not another added
 * one), so drop the misleading suggested_action and attach a note. No-op otherwise (none, all verified, or absent). */
export function withExistingEmployeeAction(blockers: Blocker[], employees: EmployeeOnboardingInfo[]): Blocker[] {
  const active = employees.filter((e) => e.terminated !== true);
  const unverified = active.filter((e) => e.onboarding_status !== EMPLOYEE_VERIFIED_STATUS);
  if (unverified.length === 0) return blockers;
  return blockers.map((b) =>
    b.id === "add_employees"
      ? {
          ...b,
          suggested_action: null,
          note:
            `${unverified.length} of ${active.length} employee(s) added but not yet verified. ` +
            `This step clears once an employee completes onboarding and is verified ` +
            `(onboarding_status "${EMPLOYEE_VERIFIED_STATUS}").`,
        }
      : b,
  );
}
