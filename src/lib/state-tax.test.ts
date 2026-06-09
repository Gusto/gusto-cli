import { describe, expect, test } from "bun:test";
import { type TaxRequirementsResponse, buildTaxRequirementSets } from "./state-tax.ts";

const caRequirements: TaxRequirementsResponse = {
  requirement_sets: [
    {
      key: "taxrates",
      effective_from: "2026-01-01",
      requirements: [
        {
          key: "usedefaultsuirates",
          editable: true,
          applicable_if: [{ key: "hasthirdpartyaccess", value: false }],
        },
      ],
    },
  ],
};

describe("buildTaxRequirementSets", () => {
  test("CA with temporary rates builds the usedefaultsuirates payload", () => {
    const result = buildTaxRequirementSets(caRequirements, "CA", true);
    if (result.status !== "submitted") throw new Error("expected submitted");
    expect(result.requirement_sets).toHaveLength(1);
    const set = result.requirement_sets[0];
    expect(set?.key).toBe("taxrates");
    expect(set?.effective_from).toBe("2026-01-01");
    expect(set?.requirements).toEqual([
      { key: "hasthirdpartyaccess", value: false },
      { key: "usedefaultsuirates", value: true },
    ]);
  });

  test("opting out of temporary rates needs manual setup", () => {
    expect(buildTaxRequirementSets(caRequirements, "CA", false).status).toBe("needs_manual_setup");
  });

  test("a state without a default rate needs manual setup", () => {
    expect(buildTaxRequirementSets(caRequirements, "NY", true).status).toBe("needs_manual_setup");
  });

  test("supported state lacking an editable usedefaultsuirates yields no_default_rate_question", () => {
    const noDefault: TaxRequirementsResponse = {
      requirement_sets: [{ key: "taxrates", requirements: [{ key: "usedefaultsuirates", editable: false }] }],
    };
    const result = buildTaxRequirementSets(noDefault, "TX", true);
    expect(result.status).toBe("no_default_rate_question");
  });
});
