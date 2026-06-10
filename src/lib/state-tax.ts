/**
 * Company-level state tax requirement helpers for `gusto company setup state-tax`.
 *
 * The setup command discovers states from employee work addresses, then for
 * each state opts into the new-employer default SUI rate where the state
 * supports it (CA/TX/FL). `buildTaxRequirementSets` turns a state's
 * tax_requirements response into the requirement_sets payload that enables
 * `usedefaultsuirates`, or reports why it can't.
 */

/** States that expose a new-employer default rate, letting setup complete
 * without the employer's actual rate notice. */
export const TEMPORARY_RATE_STATES = ["CA", "TX", "FL"];

export interface TaxRequirement {
  key: string;
  value?: unknown;
  editable?: boolean;
  applicable_if?: { key: string; value: unknown }[];
}

export interface RequirementSet {
  key: string;
  state?: string;
  effective_from?: string;
  requirements?: TaxRequirement[];
}

export interface TaxRequirementsResponse {
  requirement_sets?: RequirementSet[];
}

export type StateTaxBuildStatus = "submitted" | "needs_manual_setup" | "no_default_rate_question";

// Discriminated on status: requirement_sets only exists (and is only meaningful)
// on the "submitted" branch.
export type StateTaxBuildResult =
  | { status: "submitted"; requirement_sets: RequirementSet[] }
  | { status: "needs_manual_setup" | "no_default_rate_question" };

/** Build the requirement_sets that enable the new-employer default SUI rate
 * for `state`. Returns the reason when no default-rate path is available. */
export function buildTaxRequirementSets(
  reqs: TaxRequirementsResponse,
  state: string,
  useTemporaryRates: boolean,
): StateTaxBuildResult {
  if (!useTemporaryRates || !TEMPORARY_RATE_STATES.includes(state)) {
    return { status: "needs_manual_setup" };
  }

  const requirementSets: RequirementSet[] = [];
  for (const reqSet of reqs.requirement_sets ?? []) {
    if (reqSet.key !== "taxrates") continue;
    const useDefault = (reqSet.requirements ?? []).find((r) => r.key === "usedefaultsuirates" && r.editable === true);
    if (!useDefault) continue;

    const requirements: { key: string; value: unknown }[] = [];
    const sentKeys = new Set<string>();
    for (const dep of useDefault.applicable_if ?? []) {
      if (sentKeys.has(dep.key)) continue;
      requirements.push({ key: dep.key, value: dep.value });
      sentKeys.add(dep.key);
    }
    requirements.push({ key: "usedefaultsuirates", value: true });
    const built: RequirementSet = { state, key: reqSet.key, requirements };
    if (reqSet.effective_from !== undefined) built.effective_from = reqSet.effective_from;
    requirementSets.push(built);
  }

  if (requirementSets.length === 0) {
    return { status: "no_default_rate_question" };
  }
  return { status: "submitted", requirement_sets: requirementSets };
}
