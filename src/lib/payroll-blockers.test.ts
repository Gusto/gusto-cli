import { describe, expect, test } from "bun:test";
import type { Blocker } from "./onboarding-map.ts";
import { suggestedActionFor } from "./onboarding-map.ts";
import { enrichPayrollBlockers, fetchPayrollBlockers, payrollBlockerAction } from "./payroll-blockers.ts";

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
});

describe("fetchPayrollBlockers", () => {
  // Minimal ReadClient stub. The double-cast sidesteps the generic get<T> signature -
  // these tests only care about the body it hands back.
  type ReadClient = Parameters<typeof fetchPayrollBlockers>[0];
  const clientReturning = (body: unknown): ReadClient => ({ get: async () => ({ body }) }) as unknown as ReadClient;

  test("returns the list as-is on a well-formed array body", async () => {
    const blockers = [{ key: "needs_approval", message: "Company needs to be approved." }];
    expect(await fetchPayrollBlockers(clientReturning(blockers), "co-1")).toEqual(blockers);
  });

  test("empty array (payroll-ready) returns an empty list", async () => {
    expect(await fetchPayrollBlockers(clientReturning([]), "co-1")).toEqual([]);
  });

  // A non-array 200 is malformed: we can't conclude payroll-readiness from it, so it throws
  // (the caller degrades to a partial error + null readiness) rather than coercing to an
  // empty list, which would falsely report payroll_ready (Fresh Eyes, PR #69).
  test("throws on a non-array object body (e.g. an error envelope)", async () => {
    await expect(
      fetchPayrollBlockers(clientReturning({ errors: [{ category: "not_found" }] }), "co-1"),
    ).rejects.toThrow(/not an array/);
  });

  test("throws on a null body", async () => {
    await expect(fetchPayrollBlockers(clientReturning(null), "co-1")).rejects.toThrow(/not an array/);
  });

  test("throws on a string body", async () => {
    await expect(fetchPayrollBlockers(clientReturning("oops"), "co-1")).rejects.toThrow(/not an array/);
  });

  test("drops elements that aren't well-formed blockers (missing key/message, null, wrong types)", async () => {
    const body = [
      { key: "missing_employee_setup", message: "ok" }, // valid
      { key: "needs_approval", message: "valid wait-state" }, // valid
      { message: "no key" }, // dropped: no key
      { key: "missing_forms" }, // dropped: no message
      { key: 123, message: "numeric key" }, // dropped: non-string key
      null, // dropped
      "garbage", // dropped
    ];
    const result = await fetchPayrollBlockers(clientReturning(body), "co-1");
    expect(result.map((b) => b.key)).toEqual(["missing_employee_setup", "needs_approval"]);
  });

  test("requests the company's payroll-blockers path", async () => {
    let path = "";
    const client = {
      get: async (p: string) => {
        path = p;
        return { body: [] };
      },
    } as unknown as ReadClient;
    await fetchPayrollBlockers(client, "co-xyz");
    expect(path).toBe("/v1/companies/co-xyz/payrolls/blockers");
  });
});
