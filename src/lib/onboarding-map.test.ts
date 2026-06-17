import { describe, expect, test } from "bun:test";
import {
  SIGNATORY_STEP_ID,
  extractBlockers,
  suggestedActionFor,
  withExistingEmployeeAction,
  withSignatoryBlocker,
} from "./onboarding-map.ts";
import type { Blocker } from "./onboarding-map.ts";

describe("suggestedActionFor", () => {
  test("maps a known step to a setup command", () => {
    expect(suggestedActionFor("federal_tax_setup")).toEqual({
      command: "gusto company setup federal-tax",
      required_flags: ["--ein", "--tax-payer-type", "--filing-form", "--legal-name"],
      optional_flags: ["--taxable-as-scorp"],
      source: "cli_static_map",
    });
  });

  test("both bank steps point at the compound connect command", () => {
    expect(suggestedActionFor("add_bank_info")?.command).toBe("gusto company setup bank-account");
    expect(suggestedActionFor("verify_bank_info")?.command).toBe("gusto company setup bank-account");
  });

  test("returns null for an unmapped step", () => {
    expect(suggestedActionFor("some_unmapped_future_step")).toBeNull();
  });

  test("maps add_addresses to setup address", () => {
    expect(suggestedActionFor("add_addresses")).toEqual({
      command: "gusto company setup address",
      required_flags: ["--street-1", "--city", "--state", "--zip", "--phone"],
      optional_flags: ["--street-2", "--country", "--no-filing-address", "--no-mailing-address"],
      source: "cli_static_map",
    });
  });

  test("maps select_industry to setup industry", () => {
    expect(suggestedActionFor("select_industry")).toEqual({
      command: "gusto company setup industry",
      required_flags: ["--naics-code"],
      optional_flags: ["--title", "--sic-code"],
      source: "cli_static_map",
    });
  });

  test("maps the synthetic signatory step to setup signatory", () => {
    expect(suggestedActionFor(SIGNATORY_STEP_ID)).toEqual({
      command: "gusto company setup signatory",
      required_flags: ["--first-name", "--last-name", "--email"],
      optional_flags: ["--title"],
      source: "cli_static_map",
    });
  });
});

describe("withSignatoryBlocker", () => {
  const blocker = (id: string): Blocker => ({ id, requirements: [], suggested_action: suggestedActionFor(id) });

  test("injects the signatory blocker immediately before sign_all_forms", () => {
    const result = withSignatoryBlocker([blocker("federal_tax_setup"), blocker("sign_all_forms")], false);
    expect(result.map((b) => b.id)).toEqual(["federal_tax_setup", SIGNATORY_STEP_ID, "sign_all_forms"]);
    expect(result[1]?.suggested_action?.command).toBe("gusto company setup signatory");
  });

  test("no-op when a signatory already exists", () => {
    const input = [blocker("sign_all_forms")];
    expect(withSignatoryBlocker(input, true)).toEqual(input);
  });

  test("no-op when sign_all_forms is not an active blocker", () => {
    const input = [blocker("federal_tax_setup")];
    expect(withSignatoryBlocker(input, false)).toEqual(input);
  });
});

describe("withExistingEmployeeAction", () => {
  const blocker = (id: string): Blocker => ({ id, requirements: [], suggested_action: suggestedActionFor(id) });

  test("no employees: keeps the static add-an-employee guidance", () => {
    const input = [blocker("add_employees")];
    expect(withExistingEmployeeAction(input, [])).toEqual(input);
  });

  test("only terminated employees count as none: keeps add guidance", () => {
    const input = [blocker("add_employees")];
    expect(
      withExistingEmployeeAction(input, [{ onboarding_status: "onboarding_completed", terminated: true }]),
    ).toEqual(input);
  });

  test("all active employees verified: no-op", () => {
    const input = [blocker("add_employees")];
    expect(withExistingEmployeeAction(input, [{ onboarding_status: "onboarding_completed" }])).toEqual(input);
  });

  test("an unverified employee exists: drops suggested_action and attaches a verify note", () => {
    const result = withExistingEmployeeAction(
      [blocker("add_employees"), blocker("federal_tax_setup")],
      [{ onboarding_status: "self_onboarding_pending_invite" }, { onboarding_status: "onboarding_completed" }],
    );
    const addEmployees = result.find((b) => b.id === "add_employees");
    expect(addEmployees?.suggested_action).toBeNull();
    expect(addEmployees?.note).toContain("not yet verified");
    expect(addEmployees?.note).toContain("1 of 2");
    // other blockers untouched
    expect(result.find((b) => b.id === "federal_tax_setup")?.suggested_action?.command).toBe(
      "gusto company setup federal-tax",
    );
  });

  test("missing or unknown onboarding_status counts as unverified and gets the note", () => {
    const result = withExistingEmployeeAction(
      [blocker("add_employees")],
      [{}, { onboarding_status: "some_future_status" }],
    );
    const addEmployees = result.find((b) => b.id === "add_employees");
    expect(addEmployees?.suggested_action).toBeNull();
    expect(addEmployees?.note).toContain("not yet verified");
    expect(addEmployees?.note).toContain("2 of 2");
  });

  test("no-op when add_employees is not among the blockers", () => {
    const input = [blocker("federal_tax_setup")];
    expect(withExistingEmployeeAction(input, [{ onboarding_status: "self_onboarding_pending_invite" }])).toEqual(input);
  });
});

describe("extractBlockers", () => {
  test("keeps required + incomplete steps and enriches with suggested_action", () => {
    const blockers = extractBlockers({
      onboarding_steps: [
        { id: "federal_tax_setup", title: "Federal tax", required: true, completed: false },
        { id: "add_bank_info", title: "Bank", required: true, completed: true },
        { id: "some_unmapped_future_step", title: "Future", required: true, completed: false },
        { id: "optional_thing", required: false, completed: false },
      ],
    });
    expect(blockers.map((b) => b.id)).toEqual(["federal_tax_setup", "some_unmapped_future_step"]);
    expect(blockers[0]?.suggested_action?.command).toBe("gusto company setup federal-tax");
    // Unmapped step still surfaces, without a command guess.
    expect(blockers[1]?.suggested_action).toBeNull();
  });

  test("empty/missing status yields no blockers", () => {
    expect(extractBlockers(undefined)).toEqual([]);
    expect(extractBlockers({})).toEqual([]);
  });
});
