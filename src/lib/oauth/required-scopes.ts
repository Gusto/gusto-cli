/** The minimum OAuth scope set the public-beta CLI surface needs.
 *
 * This file is the canonical reference for what the public-beta OAuth app
 * should grant. The partner OAuth registration for that app is kept in sync with this
 * list; any command added in a future PR that needs a new scope must update
 * this set in the same change so the audit trail stays accurate.
 *
 * The set is intentionally narrow. The writes are the per-cycle payroll flow
 * (timesheets, payroll prepare/calculate, pay schedules, reports) plus the
 * employee-offboarding path (`employments:write`, for terminate/cancel-termination);
 * other employee and contractor data stays read-only on this surface. Scopes
 * dropped from the original 50+ grant (`company_bank_accounts:write`,
 * `signatories:manage`, and the bulk employee/contractor write scopes) have no
 * in-surface consumer and are listed in `DROPPED_SCOPES` below for audit history.
 *
 * This list enumerates scopes that individual CLI commands exercise. Two
 * categories are deliberately NOT listed and remain granted: baseline auth
 * scopes (`public`, `access_token:read`), and `webhook_subscriptions:read/write`,
 * which is retained as a partner platform capability even though no CLI command
 * uses it. Their absence here is not a signal to drop them from the grant. */

export interface ScopeRequirement {
  scope: string;
  /** The CLI surfaces that need this scope, in case a future audit removes one. */
  usedBy: readonly string[];
}

export const REQUIRED_SCOPES: readonly ScopeRequirement[] = [
  // Reads
  { scope: "companies:read", usedBy: ["company show", "company locations"] },
  { scope: "employees:read", usedBy: ["employee show", "employee status", "employee list"] },
  { scope: "employments:read", usedBy: ["employee history", "employee terminations", "employee rehire"] },
  { scope: "contractors:read", usedBy: ["contractor show", "contractor list"] },
  { scope: "departments:read", usedBy: ["department list", "department show"] },
  { scope: "jobs:read", usedBy: ["employee inspect"] },
  { scope: "compensations:read", usedBy: ["employee inspect"] },
  { scope: "pay_schedules:read", usedBy: ["pay-schedule list", "pay-schedule assignments", "pay-schedule show"] },
  {
    scope: "payrolls:read",
    usedBy: ["payroll list", "ledger show", "pay-schedule periods", "pay-schedule termination-periods"],
  },
  { scope: "time_sheet:read", usedBy: ["timesheet show", "timesheet list"] },
  { scope: "company_reports:read", usedBy: ["ledger show"] },
  { scope: "company_payment_configs:read", usedBy: ["company show"] },
  { scope: "employee_federal_taxes:read", usedBy: ["employee inspect"] },
  { scope: "employee_state_taxes:read", usedBy: ["employee inspect"] },

  // Writes: the per-cycle payroll flow, plus the employee-offboarding path.
  { scope: "time_sheet:write", usedBy: ["timesheet create"] },
  { scope: "payroll_syncs:write", usedBy: ["timesheet sync"] },
  { scope: "payrolls:write", usedBy: ["payroll prepare"] },
  { scope: "payrolls:run", usedBy: ["payroll calculate"] },
  { scope: "pay_schedules:write", usedBy: ["pay-schedule create"] },
  { scope: "company_reports:write", usedBy: ["ledger show (report generate)"] },
  { scope: "employments:write", usedBy: ["employee terminate", "employee cancel-termination"] },
] as const;

/** Scopes the original OAuth app grant included but no in-surface command needs.
 * Listed here so the partner OAuth registration can be cross-checked against
 * the audit trail and so a future regression that introduces a dependent
 * command shows up in the diff. Not enforced at runtime - the partner OAuth
 * registration is the authoritative grant. */
export const DROPPED_SCOPES: readonly string[] = [
  "company_bank_accounts:write",
  "signatories:manage",
  "company_signatories:write",
  "employee_bank_accounts:write",
  "companies:write",
  "employee_payment_methods:read",
  "employee_payment_methods:write",
  "employees:write",
  "employees:manage",
  "contractors:write",
  "contractors:manage",
  "jobs:write",
  "compensations:write",
  "employee_federal_taxes:write",
  "employee_state_taxes:write",
] as const;

/** Required scopes the granted token is missing. Used by `gusto auth whoami` to
 * surface a debuggable list inline when a token's grant is narrower than the
 * CLI surface requires. */
export function findMissingScopes(granted: readonly string[]): string[] {
  const grantedSet = new Set(granted);
  return REQUIRED_SCOPES.map((r) => r.scope).filter((s) => !grantedSet.has(s));
}
