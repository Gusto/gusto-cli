import { describe, expect, test } from "bun:test";
import { ApiClient } from "../lib/api-client.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import {
  buildGeneralLedgerBody,
  executeLedgerShow,
  isReportFailed,
  isReportSucceeded,
  resolveTimeoutMs,
} from "./ledger.ts";

interface MockResponse {
  status: number;
  body?: unknown;
}

/** ApiClient whose fetch routes the general_ledger POST and the report GET to
 * canned responses, so executeLedgerShow's POST-then-poll flow is testable. */
function clientWith(responses: { post?: MockResponse; report?: MockResponse }): ApiClient {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let r: MockResponse | undefined;
    if (method === "POST" && u.includes("/reports/general_ledger")) r = responses.post;
    else if (method === "GET" && u.includes("/v1/reports/")) r = responses.report;
    if (!r) throw new Error(`unexpected request: ${method} ${u}`);
    const text = r.body !== undefined ? JSON.stringify(r.body) : "";
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "https://api.test", token: "t", apiVersion: "2026-02-01", fetchImpl, maxRetries: 0 });
}

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
  test("matches the API's lowercase 'succeeded', case-insensitively", () => {
    // The live API returns lowercase statuses (verified against sandbox).
    expect(isReportSucceeded({ status: "succeeded" })).toBe(true);
    expect(isReportSucceeded({ status: "Succeeded" })).toBe(true);
    expect(isReportSucceeded({ status: "pending" })).toBe(false);
    expect(isReportSucceeded({ status: "failed" })).toBe(false);
    expect(isReportSucceeded({})).toBe(false);
  });
});

describe("isReportFailed", () => {
  test("matches the API's lowercase 'failed', case-insensitively", () => {
    expect(isReportFailed({ status: "failed" })).toBe(true);
    expect(isReportFailed({ status: "Failed" })).toBe(true);
    expect(isReportFailed({ status: "pending" })).toBe(false);
    expect(isReportFailed({ status: "succeeded" })).toBe(false);
    expect(isReportFailed({})).toBe(false);
  });
});

describe("resolveTimeoutMs", () => {
  test("undefined is ok with no ms (use the poll default)", () => {
    expect(resolveTimeoutMs(undefined)).toEqual({ ok: true });
  });

  test("a positive number of seconds converts to ms", () => {
    expect(resolveTimeoutMs("60")).toEqual({ ok: true, ms: 60_000 });
    expect(resolveTimeoutMs("1.5")).toEqual({ ok: true, ms: 1_500 });
  });

  test("zero, negative, non-numeric, and non-finite are rejected", () => {
    expect(resolveTimeoutMs("0")).toEqual({ ok: false });
    expect(resolveTimeoutMs("-1")).toEqual({ ok: false });
    expect(resolveTimeoutMs("abc")).toEqual({ ok: false });
    expect(resolveTimeoutMs("Infinity")).toEqual({ ok: false });
  });
});

describe("executeLedgerShow", () => {
  const PAYROLL = "11111111-1111-1111-1111-111111111111";

  test("--no-wait returns the request_uuid + poll_path without polling", async () => {
    const client = clientWith({ post: { status: 200, body: { request_uuid: "req-1" } } });
    const result = await executeLedgerShow(client, PAYROLL, { wait: false });
    expect(result).toEqual({
      ok: true,
      data: { request_uuid: "req-1", status: "pending", poll_path: "/v1/reports/req-1" },
    });
  });

  test("waits and returns the completed report body", async () => {
    const client = clientWith({
      post: { status: 200, body: { request_uuid: "req-1" } },
      report: { status: 200, body: { status: "succeeded", report_urls: ["https://x/gl.json"] } },
    });
    const result = await executeLedgerShow(client, PAYROLL, {});
    expect(result).toEqual({ ok: true, data: { status: "succeeded", report_urls: ["https://x/gl.json"] } });
  });

  test("a null response body is an error, not a silent success", async () => {
    const client = clientWith({ post: { status: 200, body: null } });
    const result = await executeLedgerShow(client, PAYROLL, { wait: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("unexpected_response");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
  });

  test("a body without request_uuid is an error", async () => {
    const client = clientWith({ post: { status: 200, body: { something_else: true } } });
    const result = await executeLedgerShow(client, PAYROLL, { wait: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("unexpected_response");
  });

  test("a failed POST is mapped to an API error result", async () => {
    const client = clientWith({ post: { status: 404, body: { errors: ["not found"] } } });
    const result = await executeLedgerShow(client, PAYROLL, { wait: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });

  test("a timeout before any poll attempt reports attempts:0 and omits last_status", async () => {
    // timeoutMs:0 => the deadline is already reached on entry, so poll throws
    // before any GET completes (the lastBody-undefined edge from review r814).
    const client = clientWith({
      post: { status: 200, body: { request_uuid: "req-1" } },
      report: { status: 200, body: { status: "pending" } },
    });
    const result = await executeLedgerShow(client, PAYROLL, { timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("report_timeout");
    expect(result.exitCode).toBe(ExitCode.Timeout);
    const details = result.error.details as { attempts: number; last_status?: unknown };
    expect(details.attempts).toBe(0);
    expect("last_status" in details).toBe(false);
  });

  test("a terminally failed report yields report_failed", async () => {
    const client = clientWith({
      post: { status: 200, body: { request_uuid: "req-1" } },
      report: { status: 200, body: { status: "failed" } },
    });
    const result = await executeLedgerShow(client, PAYROLL, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("report_failed");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
  });
});
