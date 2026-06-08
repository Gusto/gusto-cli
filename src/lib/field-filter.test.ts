import { describe, expect, test } from "bun:test";
import { availableFields, parseFieldList, selectFields } from "./field-filter.ts";

describe("parseFieldList", () => {
  test("splits on commas and trims whitespace", () => {
    expect(parseFieldList("uuid, email ,name")).toEqual(["uuid", "email", "name"]);
  });

  test("drops empty segments", () => {
    expect(parseFieldList("uuid,,email,")).toEqual(["uuid", "email"]);
  });

  test("dedupes repeated fields, keeping first occurrence", () => {
    expect(parseFieldList("uuid,email,uuid")).toEqual(["uuid", "email"]);
  });

  test("returns an empty array for a blank string", () => {
    expect(parseFieldList("")).toEqual([]);
    expect(parseFieldList("   ")).toEqual([]);
    expect(parseFieldList("  ,  ")).toEqual([]);
  });
});

describe("selectFields", () => {
  test("picks only the named keys from an object", () => {
    expect(selectFields({ uuid: "u1", email: "a@b.com", name: "Jane" }, ["uuid", "email"])).toEqual({
      uuid: "u1",
      email: "a@b.com",
    });
  });

  test("preserves source key order regardless of the requested order", () => {
    const result = selectFields({ uuid: "u1", email: "a@b.com", name: "Jane" }, ["name", "uuid"]);
    expect(Object.keys(result as object)).toEqual(["uuid", "name"]);
  });

  test("picks named keys from each object in an array, preserving structure", () => {
    const rows = [
      { uuid: "u1", email: "a@b.com", name: "Jane" },
      { uuid: "u2", email: "c@d.com", name: "John" },
    ];
    expect(selectFields(rows, ["uuid"])).toEqual([{ uuid: "u1" }, { uuid: "u2" }]);
  });

  test("omits an absent key per-row when arrays are non-uniform", () => {
    const rows = [
      { uuid: "u1", email: "a@b.com" },
      { uuid: "u2" },
    ];
    expect(selectFields(rows, ["uuid", "email"])).toEqual([{ uuid: "u1", email: "a@b.com" }, { uuid: "u2" }]);
  });

  test("silently omits keys that are absent rather than erroring", () => {
    expect(selectFields({ uuid: "u1" }, ["uuid", "missing"])).toEqual({ uuid: "u1" });
  });

  test("returns the data unchanged when no fields are requested", () => {
    const data = { uuid: "u1", email: "a@b.com" };
    expect(selectFields(data, [])).toEqual(data);
  });

  test("passes primitives, null, and undefined through untouched", () => {
    expect(selectFields("hello", ["uuid"])).toBe("hello");
    expect(selectFields(42, ["uuid"])).toBe(42);
    expect(selectFields(null, ["uuid"])).toBeNull();
    expect(selectFields(undefined, ["uuid"])).toBeUndefined();
  });

  test("leaves non-object array elements untouched", () => {
    expect(selectFields(["a", "b"], ["uuid"])).toEqual(["a", "b"]);
  });
});

describe("availableFields", () => {
  test("returns an object's top-level keys in source order", () => {
    expect(availableFields({ uuid: "u1", email: "a@b.com", name: "Jane" })).toEqual(["uuid", "email", "name"]);
  });

  test("returns the union of keys across array rows, in first-seen order", () => {
    const rows = [
      { uuid: "u1", email: "a@b.com" },
      { uuid: "u2", phone: "555" },
    ];
    expect(availableFields(rows)).toEqual(["uuid", "email", "phone"]);
  });

  test("returns an empty array for primitives, null, undefined, and empty collections", () => {
    expect(availableFields("hello")).toEqual([]);
    expect(availableFields(null)).toEqual([]);
    expect(availableFields(undefined)).toEqual([]);
    expect(availableFields([])).toEqual([]);
  });
});
