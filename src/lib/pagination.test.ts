import { describe, expect, test } from "bun:test";
import { decodeCursor, detectNext, encodeCursor, withPageParams } from "./pagination.ts";

describe("cursor codec", () => {
  test("round-trips page and per", () => {
    const token = encodeCursor(3, 100);
    expect(decodeCursor(token)).toEqual({ page: 3, per: 100 });
  });

  test("is opaque (not the literal page:per)", () => {
    expect(encodeCursor(2, 50)).not.toContain("2:50");
  });

  test("rejects garbage", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  test("rejects non-positive values", () => {
    expect(decodeCursor(encodeCursor(0, 100))).toBeNull();
  });
});

describe("withPageParams", () => {
  test("sets page and per on a relative path", () => {
    expect(withPageParams("/v1/companies/co-1/employees", 2, 100)).toBe(
      "/v1/companies/co-1/employees?page=2&per=100",
    );
  });
});

describe("detectNext", () => {
  test("trusts X-Total-Pages when present (more pages)", () => {
    expect(detectNext({ "x-total-pages": "5" }, 2, 10, 25)).toBe(3);
  });
  test("trusts X-Total-Pages when present (last page)", () => {
    expect(detectNext({ "x-total-pages": "5" }, 5, 10, 25)).toBeUndefined();
  });
  test("falls back to fullness when no header (full page -> more)", () => {
    expect(detectNext({}, 1, 100, 100)).toBe(2);
  });
  test("falls back to fullness when no header (short page -> end)", () => {
    expect(detectNext({}, 1, 40, 100)).toBeUndefined();
  });
  test("empty page ends the walk", () => {
    expect(detectNext({}, 3, 0, 100)).toBeUndefined();
  });
});
