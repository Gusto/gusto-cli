import { describe, expect, test } from "bun:test";
import { parseScopes, summarizeGrantedScopes } from "./scopes.ts";

describe("parseScopes", () => {
  test("splits, de-dupes, sorts; tolerates empty/undefined", () => {
    expect(parseScopes("employees:read employees:read companies:read")).toEqual([
      "companies:read",
      "employees:read",
    ]);
    expect(parseScopes("a a")).toEqual(["a"]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes("   ")).toEqual([]);
  });
});

describe("summarizeGrantedScopes", () => {
  test("groups scopes by resource with sorted actions", () => {
    const summary = summarizeGrantedScopes([
      "employees:read",
      "employees:write",
      "employees:manage",
      "pay_schedules:read",
      "companies:write",
    ]);
    expect(summary).toEqual([
      { resource: "companies", access: ["write"] },
      { resource: "employees", access: ["manage", "read", "write"] },
      { resource: "pay_schedules", access: ["read"] },
    ]);
  });

  test("skips bare scopes with no action (e.g. 'public')", () => {
    expect(summarizeGrantedScopes(["public", "employees:read"])).toEqual([
      { resource: "employees", access: ["read"] },
    ]);
  });

  test("empty input yields an empty summary", () => {
    expect(summarizeGrantedScopes([])).toEqual([]);
  });
});
