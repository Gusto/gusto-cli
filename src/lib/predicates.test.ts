import { describe, expect, test } from "bun:test";
import { isObject } from "./predicates.ts";

describe("isObject", () => {
  test("is true for plain objects and arrays (array-permissive)", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject([])).toBe(true);
  });

  test("is false for null and non-objects", () => {
    expect(isObject(null)).toBe(false);
    expect(isObject(undefined)).toBe(false);
    expect(isObject("s")).toBe(false);
    expect(isObject(1)).toBe(false);
  });
});
