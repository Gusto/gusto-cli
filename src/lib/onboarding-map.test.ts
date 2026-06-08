import { describe, expect, test } from "bun:test";
import { extractBlockers, suggestedActionFor } from "./onboarding-map.ts";

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
