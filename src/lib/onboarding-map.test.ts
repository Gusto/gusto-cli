import { describe, expect, test } from "bun:test";
import { SIGNATORY_STEP_ID, extractBlockers, suggestedActionFor, withSignatoryBlocker } from "./onboarding-map.ts";
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
    expect(suggestedActionFor("select_industry")).toBeNull();
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

describe("extractBlockers", () => {
  test("keeps required + incomplete steps and enriches with suggested_action", () => {
    const blockers = extractBlockers({
      onboarding_steps: [
        { id: "federal_tax_setup", title: "Federal tax", required: true, completed: false },
        { id: "add_bank_info", title: "Bank", required: true, completed: true },
        { id: "select_industry", title: "Industry", required: true, completed: false },
        { id: "optional_thing", required: false, completed: false },
      ],
    });
    expect(blockers.map((b) => b.id)).toEqual(["federal_tax_setup", "select_industry"]);
    expect(blockers[0]?.suggested_action?.command).toBe("gusto company setup federal-tax");
    // Unmapped step still surfaces, without a command guess.
    expect(blockers[1]?.suggested_action).toBeNull();
  });

  test("empty/missing status yields no blockers", () => {
    expect(extractBlockers(undefined)).toEqual([]);
    expect(extractBlockers({})).toEqual([]);
  });
});
