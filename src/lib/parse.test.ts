import { describe, expect, test } from "bun:test";
import type { BlockedOn } from "./output.ts";
import {
  isValidIso8601,
  isValidIsoDate,
  parseNonNegativeNumber,
  parsePositiveNumber,
  pushRequiredIsoDate,
} from "./parse.ts";

describe("pushRequiredIsoDate", () => {
  test("a missing value pushes a required blocker for the field", () => {
    const blocked: BlockedOn[] = [];
    pushRequiredIsoDate(blocked, "start-date", undefined);
    expect(blocked).toEqual([{ field: "start-date", reason: "required (YYYY-MM-DD)" }]);
  });

  test("a malformed value pushes a format blocker for the field", () => {
    const blocked: BlockedOn[] = [];
    pushRequiredIsoDate(blocked, "start-date", "2026-13-45");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.field).toBe("start-date");
    expect(blocked[0]?.reason).toContain("YYYY-MM-DD");
  });

  test("a valid YYYY-MM-DD value pushes nothing", () => {
    const blocked: BlockedOn[] = [];
    pushRequiredIsoDate(blocked, "start-date", "2026-07-01");
    expect(blocked).toEqual([]);
  });
});

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

  test("rejects hex, binary, and scientific notation (decimal-only)", () => {
    for (const raw of ["0x10", "0b11", "1e3", "+5", ".5", "5."]) {
      expect(parseNonNegativeNumber(raw).ok).toBe(false);
    }
  });

  test("accepts a plain decimal with a fractional part", () => {
    expect(parseNonNegativeNumber("12.75")).toEqual({ ok: true, value: 12.75 });
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
