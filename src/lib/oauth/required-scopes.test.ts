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

  test("payrolls:run is dropped, not required (money movement is out of scope for V1 beta)", () => {
    expect(DROPPED_SCOPES).toContain("payrolls:run");
    expect(REQUIRED_SCOPES.map((r) => r.scope)).not.toContain("payrolls:run");
  });

  test("contractor write scopes are required for the invite-only contractor add, not dropped", () => {
    const required = REQUIRED_SCOPES.map((r) => r.scope);
    expect(required).toContain("contractors:write");
    expect(required).toContain("contractors:manage");
    expect(DROPPED_SCOPES).not.toContain("contractors:write");
    expect(DROPPED_SCOPES).not.toContain("contractors:manage");
  });

  test("employee write scopes stay dropped (only contractor add returns to the write surface)", () => {
    expect(DROPPED_SCOPES).toContain("employees:write");
    expect(DROPPED_SCOPES).toContain("employees:manage");
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
    const granted = [...REQUIRED_SCOPES.map((r) => r.scope), "payrolls:run", "something_else:write"];
    expect(findMissingScopes(granted)).toEqual([]);
  });
});
