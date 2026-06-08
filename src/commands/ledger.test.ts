import { describe, expect, test } from "bun:test";
import { buildGeneralLedgerBody, isReportFailed, isReportSucceeded } from "./ledger.ts";

describe("buildGeneralLedgerBody", () => {
  test("applies server defaults when nothing is supplied", () => {
    expect(buildGeneralLedgerBody({})).toEqual({ aggregation: "default", integration_type: "" });
  });

  test("passes through supplied values", () => {
    expect(buildGeneralLedgerBody({ aggregation: "journal", integrationType: "quickbooks" })).toEqual({
      aggregation: "journal",
      integration_type: "quickbooks",
    });
  });
});

describe("isReportSucceeded", () => {
  test("true only for the Succeeded status", () => {
    expect(isReportSucceeded({ status: "Succeeded" })).toBe(true);
    expect(isReportSucceeded({ status: "Pending" })).toBe(false);
    expect(isReportSucceeded({ status: "Failed" })).toBe(false);
    expect(isReportSucceeded({})).toBe(false);
  });
});

describe("isReportFailed", () => {
  test("true only for the Failed status", () => {
    expect(isReportFailed({ status: "Failed" })).toBe(true);
    expect(isReportFailed({ status: "Pending" })).toBe(false);
    expect(isReportFailed({ status: "Succeeded" })).toBe(false);
    expect(isReportFailed({})).toBe(false);
  });
});
