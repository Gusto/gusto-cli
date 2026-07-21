import { describe, expect, test } from "bun:test";
import { ApiClient } from "../lib/api-client.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { buildReportBody, executeReportGet, executeReportRun } from "./report.ts";

interface MockResponse {
  status: number;
  body?: unknown;
}

interface Call {
  method: string;
  url: string;
}

/** ApiClient whose fetch routes the report create POST and the report GET to canned
 * responses and records every request, so the create-then-poll flow (and the exact
 * paths it hits) is testable with a mocked fetch. */
function clientWith(responses: { post?: MockResponse; report?: MockResponse }, calls: Call[] = []): ApiClient {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url: u });
    let r: MockResponse | undefined;
    if (method === "POST" && u.includes("/reports")) r = responses.post;
    else if (method === "GET" && u.includes("/v1/reports/")) r = responses.report;
    if (!r) throw new Error(`unexpected request: ${method} ${u}`);
    const text = r.body !== undefined ? JSON.stringify(r.body) : "";
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: "https://api.test", token: "t", apiVersion: "2026-02-01", fetchImpl, maxRetries: 0 });
}

describe("buildReportBody", () => {
  test("maps CLI flags onto the verified Reports API param names", () => {
    expect(
      buildReportBody({
        columns: ["gross_earnings", "net_pay"],
        groupBy: ["payroll", "employee"],
        from: "2026-01-01",
        to: "2026-03-31",
        dateFilterType: "check_date",
        withTotals: true,
        fileType: "json",
        name: "Q1 register",
      }),
    ).toEqual({
      columns: ["gross_earnings", "net_pay"],
      file_type: "json",
      groupings: ["payroll", "employee"],
      start_date: "2026-01-01",
      end_date: "2026-03-31",
      date_filter_type: "check_date",
      with_totals: true,
      custom_name: "Q1 register",
    });
  });

  test("defaults file_type to json and omits absent optional fields", () => {
    expect(buildReportBody({ columns: ["gross_earnings"] })).toEqual({
      columns: ["gross_earnings"],
      file_type: "json",
    });
  });

  test("omits with_totals unless the flag is set", () => {
    const body = buildReportBody({ columns: ["net_pay"], withTotals: false });
    expect("with_totals" in body).toBe(false);
  });
});

describe("executeReportRun", () => {
  const COMPANY = "39be7e0e-1111-2222-3333-444444444444";

  test("creates company-scoped and polls the TOP-LEVEL report path (not company-scoped)", async () => {
    // Regression guard: report retrieval must hit GET /v1/reports/{uuid}, never
    // GET /v1/companies/{id}/reports/{uuid} (which 404s - the route does not exist).
    const calls: Call[] = [];
    const client = clientWith(
      {
        post: { status: 201, body: { request_uuid: "req-1" } },
        report: { status: 200, body: { status: "succeeded", report_urls: ["https://x/r.json"] } },
      },
      calls,
    );
    const result = await executeReportRun(client, COMPANY, { columns: ["net_pay"] });
    expect(result.ok).toBe(true);

    const post = calls.find((c) => c.method === "POST");
    const get = calls.find((c) => c.method === "GET");
    expect(post?.url).toBe(`https://api.test/v1/companies/${COMPANY}/reports`);
    expect(get?.url).toBe("https://api.test/v1/reports/req-1");
    // The specific shape of the bug: the poll path is NOT built off the company-scoped create path.
    expect(get?.url).not.toContain("/companies/");
  });

  test("--no-wait returns the request_uuid + top-level poll_path without polling", async () => {
    const calls: Call[] = [];
    const client = clientWith({ post: { status: 201, body: { request_uuid: "req-1" } } }, calls);
    const result = await executeReportRun(client, COMPANY, { columns: ["net_pay"], wait: false });
    expect(result).toEqual({
      ok: true,
      data: { request_uuid: "req-1", status: "pending", poll_path: "/v1/reports/req-1" },
    });
    expect(calls.some((c) => c.method === "GET")).toBe(false);
  });

  test("waits and returns the completed report body", async () => {
    const client = clientWith({
      post: { status: 201, body: { request_uuid: "req-1" } },
      report: { status: 200, body: { status: "succeeded", report_urls: ["https://x/r.json"] } },
    });
    const result = await executeReportRun(client, COMPANY, { columns: ["net_pay"] });
    expect(result).toEqual({ ok: true, data: { status: "succeeded", report_urls: ["https://x/r.json"] } });
  });

  test("a body without request_uuid is an error, not a silent success", async () => {
    const client = clientWith({ post: { status: 201, body: { something_else: true } } });
    const result = await executeReportRun(client, COMPANY, { columns: ["net_pay"], wait: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("unexpected_response");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
  });

  test("a failed create POST is mapped to an API error result", async () => {
    const client = clientWith({ post: { status: 422, body: { errors: ["columns_required"] } } });
    const result = await executeReportRun(client, COMPANY, { columns: [], wait: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });

  test("a terminally failed report yields report_failed", async () => {
    const client = clientWith({
      post: { status: 201, body: { request_uuid: "req-1" } },
      report: { status: 200, body: { status: "failed" } },
    });
    const result = await executeReportRun(client, COMPANY, { columns: ["net_pay"] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("report_failed");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
    // The upstream body is exposed under `details.response` (same key the mid-poll error uses).
    expect(result.error.details).toMatchObject({ response: { status: "failed" } });
  });

  test("a timeout before any poll attempt reports report_timeout", async () => {
    const client = clientWith({
      post: { status: 201, body: { request_uuid: "req-1" } },
      report: { status: 200, body: { status: "pending" } },
    });
    const result = await executeReportRun(client, COMPANY, { columns: ["net_pay"], timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("report_timeout");
    expect(result.exitCode).toBe(ExitCode.Timeout);
  });

  test("a non-terminal error mid-poll keeps the request_uuid + poll_path so the run is resumable", async () => {
    // A 5xx (or token expiry, a 4xx) while polling leaves the report generating server-side; the
    // caller never saw the request_uuid, so the error must carry it to resume via `report get`.
    const client = clientWith({
      post: { status: 201, body: { request_uuid: "req-1" } },
      report: { status: 500, body: { message: "boom" } },
    });
    const result = await executeReportRun(client, COMPANY, { columns: ["net_pay"] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("api_server_error");
    // Upstream body under `details.response`, consistent with the report_failed branch above.
    expect(result.error.details).toMatchObject({
      request_uuid: "req-1",
      poll_path: "/v1/reports/req-1",
      response: { message: "boom" },
    });
  });
});

describe("executeReportGet", () => {
  test("polls the top-level path and returns the completed body", async () => {
    const calls: Call[] = [];
    const client = clientWith(
      { report: { status: 200, body: { status: "succeeded", report_urls: ["https://x/r.json"] } } },
      calls,
    );
    const result = await executeReportGet(client, "req-9", {});
    expect(result).toEqual({ ok: true, data: { status: "succeeded", report_urls: ["https://x/r.json"] } });
    expect(calls.every((c) => c.method === "GET" && c.url === "https://api.test/v1/reports/req-9")).toBe(true);
  });

  test("--no-wait does a single GET and returns the current status", async () => {
    const calls: Call[] = [];
    const client = clientWith({ report: { status: 200, body: { status: "pending", report_urls: [] } } }, calls);
    const result = await executeReportGet(client, "req-9", { wait: false });
    expect(result).toEqual({ ok: true, data: { status: "pending", report_urls: [] } });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://api.test/v1/reports/req-9");
  });
});
