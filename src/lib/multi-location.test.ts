import { describe, expect, test } from "bun:test";
import { ExitCode } from "./exit-codes.ts";
import { isMultiLocation, multiLocationRefusal } from "./multi-location.ts";

describe("isMultiLocation", () => {
  test("counts only addresses that are strictly active", () => {
    expect(isMultiLocation([{ active: true }, { active: true }])).toBe(true);
    expect(isMultiLocation([{ active: true }, { active: false }, { active: "true" }])).toBe(false);
    expect(isMultiLocation([{ active: true }])).toBe(false);
    expect(isMultiLocation([])).toBe(false);
  });
});

describe("multiLocationRefusal", () => {
  test("is a blocked-state refusal that names the employees", () => {
    const result = multiLocationRefusal(["ee-1"], "refused.");
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.Blocked,
      error: { code: "multi_location_not_supported", message: "refused.", employee_uuids: ["ee-1"] },
    });
  });

  test("carries the API body when there is one", () => {
    const result = multiLocationRefusal(["ee-1"], "refused.", { errors: [] });
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ errors: [] });
  });
});
