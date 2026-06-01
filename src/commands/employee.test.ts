import { describe, expect, test } from "bun:test";
import { parseComp } from "./employee.ts";

describe("parseComp", () => {
  test("1000 is the salary/hourly boundary (>= 1000 is annual salary)", () => {
    expect(parseComp("1000")).toEqual({ ok: true, comp: { annual_salary: 1000 } });
  });

  test("just under the boundary is an hourly rate", () => {
    expect(parseComp("999.99")).toEqual({ ok: true, comp: { hourly_rate: 999.99 } });
  });

  test("typical salary is annual", () => {
    expect(parseComp("120000")).toEqual({ ok: true, comp: { annual_salary: 120000 } });
  });

  test("typical hourly rate stays hourly", () => {
    expect(parseComp("25.5")).toEqual({ ok: true, comp: { hourly_rate: 25.5 } });
  });

  test("zero is rejected", () => {
    expect(parseComp("0")).toEqual({ ok: false, reason: "must be a positive number, got: 0" });
  });

  test("negative is rejected", () => {
    expect(parseComp("-5")).toEqual({ ok: false, reason: "must be a positive number, got: -5" });
  });

  test("non-numeric string is rejected", () => {
    expect(parseComp("abc")).toEqual({ ok: false, reason: "must be a positive number, got: abc" });
  });

  test("empty string is rejected", () => {
    expect(parseComp("")).toEqual({ ok: false, reason: "must be a positive number, got: " });
  });

  test("Infinity is rejected as non-finite", () => {
    expect(parseComp("Infinity")).toEqual({ ok: false, reason: "must be a positive number, got: Infinity" });
  });
});
