import { describe, expect, test } from "bun:test";
import { decodeCursor, detectNext, encodeCursor, parsePaginationFlags, withPageParams } from "./pagination.ts";

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
    expect(withPageParams("/v1/companies/co-1/employees", 2, 100)).toBe("/v1/companies/co-1/employees?page=2&per=100");
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

describe("parsePaginationFlags", () => {
  test("default: first page of 100, surfaces next", () => {
    expect(parsePaginationFlags({})).toEqual({
      ok: true,
      body: { startPage: 1, per: 100, maxItems: 100, surfaceNext: true },
    });
  });

  test("--all: walk to end at max per, no next", () => {
    expect(parsePaginationFlags({ all: true })).toEqual({
      ok: true,
      body: { startPage: 1, per: 500, maxItems: undefined, surfaceNext: false },
    });
  });

  test("--limit caps total and page size, no next", () => {
    expect(parsePaginationFlags({ limit: "50" })).toEqual({
      ok: true,
      body: { startPage: 1, per: 50, maxItems: 50, surfaceNext: false },
    });
  });

  test("--limit above max clamps per to 500 but keeps the cap", () => {
    expect(parsePaginationFlags({ limit: "1200" })).toEqual({
      ok: true,
      body: { startPage: 1, per: 500, maxItems: 1200, surfaceNext: false },
    });
  });

  test("--limit with --all is allowed; limit wins", () => {
    const r = parsePaginationFlags({ all: true, limit: "30" });
    expect(r).toEqual({ ok: true, body: { startPage: 1, per: 30, maxItems: 30, surfaceNext: false } });
  });

  test("--cursor resumes from the encoded page, surfaces next", () => {
    const token = encodeCursor(4, 100);
    expect(parsePaginationFlags({ cursor: token })).toEqual({
      ok: true,
      body: { startPage: 4, per: 100, maxItems: 100, surfaceNext: true },
    });
  });

  test("invalid --limit fails validation", () => {
    const r = parsePaginationFlags({ limit: "0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked[0]?.field).toBe("limit");
  });

  test("non-integer --limit fails validation", () => {
    expect(parsePaginationFlags({ limit: "abc" }).ok).toBe(false);
  });

  test("malformed --cursor fails validation", () => {
    const r = parsePaginationFlags({ cursor: "garbage" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked[0]?.field).toBe("cursor");
  });

  test("--cursor with --all is rejected", () => {
    expect(parsePaginationFlags({ cursor: encodeCursor(2, 100), all: true }).ok).toBe(false);
  });

  test("--cursor with --limit is rejected", () => {
    expect(parsePaginationFlags({ cursor: encodeCursor(2, 100), limit: "10" }).ok).toBe(false);
  });
});
