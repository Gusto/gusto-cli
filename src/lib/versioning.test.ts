import { describe, expect, test } from "bun:test";
import { readString, withVersion } from "./versioning.ts";

describe("readString", () => {
  test("returns a non-empty string field", () => {
    expect(readString({ v: "x" }, "v")).toBe("x");
  });
  test("undefined for an empty string", () => {
    expect(readString({ v: "" }, "v")).toBeUndefined();
  });
  test("undefined for a non-string value", () => {
    expect(readString({ v: 1 }, "v")).toBeUndefined();
  });
  test("undefined for a non-object body", () => {
    expect(readString(null, "v")).toBeUndefined();
    expect(readString("nope", "v")).toBeUndefined();
  });
});

describe("withVersion", () => {
  test("injects the version when the body has none", () => {
    expect(withVersion({ a: 1 }, "v1")).toEqual({ a: 1, version: "v1" });
  });

  test("a valid caller-supplied version wins (body returned unchanged)", () => {
    const body = { version: "caller" };
    expect(withVersion(body, "v1")).toBe(body);
  });

  test("returns the body unchanged when there is no version to inject", () => {
    const body = { a: 1 };
    expect(withVersion(body, undefined)).toBe(body);
  });

  test("an empty/invalid caller version does not clobber the injected one", () => {
    // Regression: the spread order must keep the injected version (not the empty "").
    expect(withVersion({ version: "" }, "v1")).toEqual({ version: "v1" });
  });
});
