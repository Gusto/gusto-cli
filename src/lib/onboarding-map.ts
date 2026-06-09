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

// add_bank_info and verify_bank_info are both resolved by the one compound
// connect command (create + test deposits + verify), so they share an entry.
const BANK_CONNECT: MapEntry = {
  command: "gusto company setup bank-account",
  required_flags: ["--routing", "--account-number", "--account-type"],
  optional_flags: [],
};

const BLOCKER_TO_COMMAND: Record<string, MapEntry> = {
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
  add_employees: {
    command: "gusto employee add",
    required_flags: ["--first-name", "--last-name", "--email"],
    optional_flags: ["--role", "--comp", "--admin-driven"],
  },
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
