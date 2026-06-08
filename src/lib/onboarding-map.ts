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

const BLOCKER_TO_COMMAND: Record<string, MapEntry> = {
  federal_tax_setup: {
    command: "gusto company setup federal-tax",
    required_flags: ["--ein", "--tax-payer-type", "--filing-form", "--legal-name"],
    optional_flags: ["--taxable-as-scorp"],
  },
  add_bank_info: {
    command: "gusto company setup bank-account",
    required_flags: ["--routing", "--account-number", "--account-type"],
    optional_flags: [],
  },
  // Resolved by the same compound connect (create + test deposits + verify).
  verify_bank_info: {
    command: "gusto company setup bank-account",
    required_flags: ["--routing", "--account-number", "--account-type"],
    optional_flags: [],
  },
  state_setup: {
    command: "gusto company setup state-tax",
    required_flags: [],
    optional_flags: ["--no-temporary-rates"],
  },
  payroll_schedule: {
    command: "gusto company setup pay-schedule",
    required_flags: ["--frequency"],
    // --anchor-end-of-pay-period is required for weekly/biweekly (enforced in pay-schedule.ts).
    optional_flags: ["--first-payday", "--anchor-end-of-pay-period"],
  },
  sign_all_forms: {
    command: "gusto company forms",
    required_flags: [],
    optional_flags: ["--note", "--demo-sign"],
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
