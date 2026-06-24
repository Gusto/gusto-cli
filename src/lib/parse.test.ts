import { describe, expect, test } from "bun:test";
import { isValidIso8601, isValidIsoDate, parseNonNegativeNumber, parsePositiveNumber } from "./parse.ts";

describe("parsePositiveNumber", () => {
  test("accepts a positive integer", () => {
    expect(parsePositiveNumber("42")).toEqual({ ok: true, value: 42 });
  });

  test("accepts a positive decimal", () => {
    expect(parsePositiveNumber("19.99")).toEqual({ ok: true, value: 19.99 });
  });

  test("rejects zero", () => {
    const result = parsePositiveNumber("0");
    expect(result.ok).toBe(false);
  });

  test("rejects a negative number", () => {
    const result = parsePositiveNumber("-5");
    expect(result.ok).toBe(false);
  });

  test("rejects a non-numeric string", () => {
    const result = parsePositiveNumber("abc");
    expect(result.ok).toBe(false);
  });

  test("rejects non-finite values that overflow to Infinity", () => {
    // Number("1e1000") === Infinity, which passes a bare `> 0` check but is not a real amount.
    const result = parsePositiveNumber("1e1000");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("1e1000");
  });
});

describe("parseNonNegativeNumber", () => {
  test("accepts a positive number", () => {
    expect(parseNonNegativeNumber("42")).toEqual({ ok: true, value: 42 });
  });

  test("accepts zero (an explicit override-to-zero, unlike parsePositiveNumber)", () => {
    expect(parseNonNegativeNumber("0")).toEqual({ ok: true, value: 0 });
  });

  test("rejects a negative number", () => {
    const result = parseNonNegativeNumber("-1");
    expect(result.ok).toBe(false);
  });

  test("rejects a non-numeric string", () => {
    const result = parseNonNegativeNumber("abc");
    expect(result.ok).toBe(false);
  });

  test("rejects non-finite overflow values", () => {
    const result = parseNonNegativeNumber("1e1000");
    expect(result.ok).toBe(false);
  });
});

describe("isValidIsoDate", () => {
  test("accepts a real YYYY-MM-DD date", () => {
    expect(isValidIsoDate("2026-06-01")).toBe(true);
  });

  test("rejects a non-ISO format", () => {
    expect(isValidIsoDate("06/01/2026")).toBe(false);
  });

  test("rejects an impossible calendar date", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
  });

  test("rejects a full timestamp", () => {
    expect(isValidIsoDate("2026-06-01T09:00:00Z")).toBe(false);
  });

  test("rejects junk", () => {
    expect(isValidIsoDate("not-a-date")).toBe(false);
  });
});

describe("isValidIso8601", () => {
  test("accepts a UTC timestamp", () => {
    expect(isValidIso8601("2026-06-01T09:00:00Z")).toBe(true);
  });

  test("accepts a timestamp with a UTC offset", () => {
    expect(isValidIso8601("2026-06-01T09:00:00-07:00")).toBe(true);
  });

  test("accepts a date-only value", () => {
    expect(isValidIso8601("2026-06-01")).toBe(true);
  });

  test("rejects a non-ISO format", () => {
    expect(isValidIso8601("06/01/2026")).toBe(false);
  });

  test("rejects junk", () => {
    expect(isValidIso8601("not-a-date")).toBe(false);
  });
});
