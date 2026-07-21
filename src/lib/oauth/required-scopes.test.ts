import { describe, expect, test } from "bun:test";
import { DROPPED_SCOPES, REQUIRED_SCOPES, findMissingScopes } from "./required-scopes.ts";

describe("REQUIRED_SCOPES", () => {
  test("every entry has a non-empty usedBy list", () => {
    for (const r of REQUIRED_SCOPES) {
      expect(r.usedBy.length).toBeGreaterThan(0);
    }
  });

  test("no duplicates", () => {
    const seen = new Set(REQUIRED_SCOPES.map((r) => r.scope));
    expect(seen.size).toBe(REQUIRED_SCOPES.length);
  });

  test("does not overlap with DROPPED_SCOPES (regression guard against accidental re-grant)", () => {
    const required = new Set(REQUIRED_SCOPES.map((r) => r.scope));
    for (const dropped of DROPPED_SCOPES) {
      expect(required.has(dropped)).toBe(false);
    }
  });

  test("payrolls:run is required for payroll calculate (granted to the CLI partner app)", () => {
    expect(DROPPED_SCOPES).not.toContain("payrolls:run");
    const entry = REQUIRED_SCOPES.find((r) => r.scope === "payrolls:run");
    expect(entry?.usedBy).toContain("payroll calculate");
  });

  test("departments:read is required for the department read commands", () => {
    expect(DROPPED_SCOPES).not.toContain("departments:read");
    const entry = REQUIRED_SCOPES.find((r) => r.scope === "departments:read");
    expect(entry?.usedBy).toEqual(expect.arrayContaining(["department list", "department show"]));
  });

  test("employments:write is required for the employee-offboarding commands (granted to the CLI partner app)", () => {
    expect(DROPPED_SCOPES).not.toContain("employments:write");
    const entry = REQUIRED_SCOPES.find((r) => r.scope === "employments:write");
    expect(entry?.usedBy).toContain("employee terminate");
    expect(entry?.usedBy).toContain("employee cancel-termination");
  });
});

describe("findMissingScopes", () => {
  test("returns the required scopes the granted set lacks", () => {
    const granted = ["employees:read", "companies:read"];
    const missing = findMissingScopes(granted);
    expect(missing).toContain("contractors:read");
    expect(missing).toContain("payrolls:read");
    expect(missing).not.toContain("employees:read");
  });

  test("returns an empty list when every required scope is granted", () => {
    const granted = REQUIRED_SCOPES.map((r) => r.scope);
    expect(findMissingScopes(granted)).toEqual([]);
  });

  test("ignores granted scopes outside the required set (extra scopes are not flagged here)", () => {
    const granted = [...REQUIRED_SCOPES.map((r) => r.scope), "company_bank_accounts:write", "something_else:write"];
    expect(findMissingScopes(granted)).toEqual([]);
  });
});
