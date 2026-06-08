import { describe, expect, test } from "bun:test";
import { parseFieldList, selectFields } from "./field-filter.ts";

describe("parseFieldList", () => {
  test("splits on commas and trims whitespace", () => {
    expect(parseFieldList("uuid, email ,name")).toEqual(["uuid", "email", "name"]);
  });

  test("drops empty segments", () => {
    expect(parseFieldList("uuid,,email,")).toEqual(["uuid", "email"]);
  });

  test("returns an empty array for a blank string", () => {
    expect(parseFieldList("")).toEqual([]);
    expect(parseFieldList("   ")).toEqual([]);
  });
});

describe("selectFields", () => {
  test("picks only the named keys from an object", () => {
    expect(selectFields({ uuid: "u1", email: "a@b.com", name: "Jane" }, ["uuid", "email"])).toEqual({
      uuid: "u1",
      email: "a@b.com",
    });
  });

  test("picks named keys from each object in an array, preserving structure", () => {
    const rows = [
      { uuid: "u1", email: "a@b.com", name: "Jane" },
      { uuid: "u2", email: "c@d.com", name: "John" },
    ];
    expect(selectFields(rows, ["uuid"])).toEqual([{ uuid: "u1" }, { uuid: "u2" }]);
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
