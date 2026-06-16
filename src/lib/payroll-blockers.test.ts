import { describe, expect, test } from "bun:test";
import type { Blocker } from "./onboarding-map.ts";
import { suggestedActionFor } from "./onboarding-map.ts";
import { enrichPayrollBlockers, payrollBlockerAction } from "./payroll-blockers.ts";

describe("payrollBlockerAction", () => {
  test("maps missing_employee_setup to the employee personal-details command", () => {
    expect(payrollBlockerAction("missing_employee_setup")?.command).toBe("gusto employee add personal-details");
  });

  test("both signatory blockers point at the signatory setup command", () => {
    expect(payrollBlockerAction("missing_signatory")?.command).toBe("gusto company setup signatory");
    expect(payrollBlockerAction("invalid_signatory")?.command).toBe("gusto company setup signatory");
  });

  test("both pay-schedule blockers point at the pay-schedule command", () => {
    expect(payrollBlockerAction("missing_pay_schedule")?.command).toBe("gusto company setup pay-schedule");
    expect(payrollBlockerAction("pay_schedule_setup_not_complete")?.command).toBe("gusto company setup pay-schedule");
  });

  test("missing/unverified bank both resolve through the one bank-account command", () => {
    expect(payrollBlockerAction("missing_bank_info")?.command).toBe("gusto company setup bank-account");
    expect(payrollBlockerAction("missing_bank_verification")?.command).toBe("gusto company setup bank-account");
  });

  test("reuses the onboarding-map definition (same flags), not a divergent copy", () => {
    expect(payrollBlockerAction("missing_federal_tax_setup")).toEqual(suggestedActionFor("federal_tax_setup"));
  });

  test("wait-states and infra errors have no command", () => {
    for (const key of ["needs_approval", "pending_payroll_review", "suspended", "eftps_in_error", "geocode_needed"]) {
      expect(payrollBlockerAction(key)).toBeNull();
    }
  });
});

describe("enrichPayrollBlockers", () => {
  const onboardingBlocker = (id: string): Blocker => ({
    id,
    requirements: [],
    suggested_action: suggestedActionFor(id),
  });

  test("enriches each blocker with its resolving command", () => {
    const result = enrichPayrollBlockers([{ key: "missing_employee_setup", message: "Add employee details." }], []);
    expect(result).toEqual([
      {
        key: "missing_employee_setup",
        message: "Add employee details.",
        suggested_action: suggestedActionFor("add_employees"),
      },
    ]);
  });

  test("drops needs_onboarding - the onboarding flow already drives it", () => {
    const result = enrichPayrollBlockers([{ key: "needs_onboarding", message: "Finish onboarding." }], []);
    expect(result).toEqual([]);
  });

  test("dedupes a payroll blocker whose command is an open onboarding blocker", () => {
    // federal_tax_setup is still an open onboarding blocker, so the mirrored
    // missing_federal_tax_setup is redundant and dropped; missing_employee_setup stays.
    const result = enrichPayrollBlockers(
      [
        { key: "missing_federal_tax_setup", message: "Set up federal tax." },
        { key: "missing_employee_setup", message: "Add employee details." },
      ],
      [onboardingBlocker("federal_tax_setup")],
    );
    expect(result.map((b) => b.key)).toEqual(["missing_employee_setup"]);
  });

  test("keeps a payroll gate that outlives its onboarding step", () => {
    // The bank onboarding step is complete (not in blocked_on), so missing_bank_verification
    // is a genuine additional payroll gate and must surface.
    const result = enrichPayrollBlockers([{ key: "missing_bank_verification", message: "Verify bank." }], []);
    expect(result.map((b) => b.key)).toEqual(["missing_bank_verification"]);
  });

  test("always surfaces command-less wait-states (they can't collide with onboarding)", () => {
    const result = enrichPayrollBlockers(
      [{ key: "needs_approval", message: "Company needs approval." }],
      [onboardingBlocker("federal_tax_setup")],
    );
    expect(result).toEqual([{ key: "needs_approval", message: "Company needs approval.", suggested_action: null }]);
  });

  test("tolerates a malformed blocker entry without a key", () => {
    const result = enrichPayrollBlockers([{ message: "no key" } as unknown as { key: string; message: string }], []);
    expect(result).toEqual([]);
  });
});
