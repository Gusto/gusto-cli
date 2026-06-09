import { describe, expect, test } from "bun:test";
import { toQueryString } from "./query.ts";

describe("toQueryString", () => {
  test("empty object yields an empty string (no leading ?)", () => {
    expect(toQueryString({})).toBe("");
  });

  test("an object of only undefined values yields an empty string", () => {
    expect(toQueryString({ a: undefined, b: undefined })).toBe("");
  });

  test("a single value yields ?key=value", () => {
    expect(toQueryString({ processing_statuses: "processed" })).toBe("?processing_statuses=processed");
  });

  test("multiple values are joined with & in insertion order", () => {
    expect(toQueryString({ a: "1", b: "2", c: "3" })).toBe("?a=1&b=2&c=3");
  });

  test("undefined values are dropped, surviving keys keep their order", () => {
    expect(toQueryString({ a: "1", b: undefined, c: "3" })).toBe("?a=1&c=3");
  });

  test("empty-string values are dropped", () => {
    expect(toQueryString({ a: "", b: "2" })).toBe("?b=2");
  });

  test("array values are joined with a comma (then encoded)", () => {
    expect(toQueryString({ processing_statuses: ["processed", "unprocessed"] })).toBe(
      "?processing_statuses=processed%2Cunprocessed",
    );
  });

  test("empty arrays are dropped", () => {
    expect(toQueryString({ a: [], b: "2" })).toBe("?b=2");
  });

  test("values are URL-encoded", () => {
    expect(toQueryString({ sort_order: "pay date" })).toBe("?sort_order=pay%20date");
  });
});
