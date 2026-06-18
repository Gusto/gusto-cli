import { describe, expect, test } from "bun:test";
import { ApiClient } from "../lib/api-client.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { stubApiClient } from "../lib/test-support.ts";
import {
  buildStateTaxBody,
  compensationBody,
  employeeCreateBlockers,
  employeeCreateBody,
  federalTaxBlockers,
  federalTaxBody,
  homeAddressBlockers,
  homeAddressBody,
  introspectStateTax,
  jobBlockers,
  jobBody,
  manageBlockers,
  manageIdentityBody,
  parseAnswerFlags,
  paymentMethodBlockers,
  resolveManageMode,
  resolveWorkAddressLocation,
  runFederalTax,
  runJob,
  runManage,
  runPaymentMethod,
  runStateTax,
  workAddressBlockers,
  workAddressBody,
} from "./employee-add.ts";

describe("employeeCreateBlockers", () => {
  test("flags every missing required field", () => {
    expect(employeeCreateBlockers({}).map((b) => b.field)).toEqual(["first-name", "last-name", "email"]);
  });

  test("accepts a complete identity", () => {
    expect(employeeCreateBlockers({ firstName: "Jane", lastName: "Doe", email: "j@x.com" })).toEqual([]);
  });
});

describe("employeeCreateBody", () => {
  test("builds a self-onboarding create body by default", () => {
    expect(employeeCreateBody({ firstName: "Jane", lastName: "Doe", email: "j@x.com" })).toEqual({
      first_name: "Jane",
      last_name: "Doe",
      email: "j@x.com",
      self_onboarding: true,
    });
  });

  test("--admin-driven flips self_onboarding off", () => {
    expect(
      employeeCreateBody({ firstName: "Jane", lastName: "Doe", email: "j@x.com", adminDriven: true }),
    ).toMatchObject({ self_onboarding: false });
  });

  test("merges typed personal details (ssn, date_of_birth) when present", () => {
    expect(
      employeeCreateBody({
        firstName: "Jane",
        lastName: "Doe",
        email: "j@x.com",
        ssn: "123-45-6789",
        dateOfBirth: "1990-01-01",
      }),
    ).toMatchObject({ ssn: "123-45-6789", date_of_birth: "1990-01-01" });
  });
});

describe("homeAddressBlockers", () => {
  test("flags every missing required field", () => {
    expect(homeAddressBlockers({}).map((b) => b.field)).toEqual(["street-1", "city", "state", "zip"]);
  });

  test("accepts a complete address", () => {
    expect(homeAddressBlockers({ street1: "300 3rd St", city: "SF", state: "CA", zip: "94107" })).toEqual([]);
  });
});

describe("homeAddressBody", () => {
  test("builds the minimal required body", () => {
    expect(homeAddressBody({ street1: "300 3rd St", city: "San Francisco", state: "CA", zip: "94107" })).toEqual({
      street_1: "300 3rd St",
      city: "San Francisco",
      state: "CA",
      zip: "94107",
    });
  });

  test("includes street_2 and effective_date when provided", () => {
    expect(
      homeAddressBody({
        street1: "300 3rd St",
        street2: "Apt 2",
        city: "SF",
        state: "CA",
        zip: "94107",
        effectiveDate: "2026-01-01",
      }),
    ).toMatchObject({ street_2: "Apt 2", effective_date: "2026-01-01" });
  });
});

describe("workAddressBlockers", () => {
  test("flags missing effective-date (location-uuid is optional - defaults to the primary location)", () => {
    expect(workAddressBlockers({}).map((b) => b.field)).toEqual(["effective-date"]);
  });

  test("accepts a complete work address", () => {
    expect(workAddressBlockers({ locationUuid: "loc-1", effectiveDate: "2026-01-01" })).toEqual([]);
  });

  test("accepts an effective-date alone (the primary location will be resolved server-side)", () => {
    expect(workAddressBlockers({ effectiveDate: "2026-01-01" })).toEqual([]);
  });
});

describe("workAddressBody", () => {
  test("builds {location_uuid, effective_date}", () => {
    expect(workAddressBody({ locationUuid: "loc-1", effectiveDate: "2026-01-01" })).toEqual({
      location_uuid: "loc-1",
      effective_date: "2026-01-01",
    });
  });
});

describe("resolveWorkAddressLocation", () => {
  test("returns the override without hitting the API when --location-uuid is supplied", async () => {
    const { client, calls } = stubApiClient({});
    const result = await resolveWorkAddressLocation(client, "co-1", "loc-override");
    expect(result).toEqual({ ok: true, data: { locationUuid: "loc-override" } });
    expect(calls).toHaveLength(0);
  });

  test("picks the primary location when --location-uuid is omitted", async () => {
    const { client } = stubApiClient({
      "GET /v1/companies/co-1/locations": [200, [{ uuid: "loc-1" }, { uuid: "loc-2", primary: true }]],
    });
    const result = await resolveWorkAddressLocation(client, "co-1", undefined);
    expect(result).toEqual({ ok: true, data: { locationUuid: "loc-2" } });
  });

  test("falls back to the first location when no primary/filing flag is set", async () => {
    const { client } = stubApiClient({
      "GET /v1/companies/co-1/locations": [200, [{ uuid: "loc-1" }, { uuid: "loc-2" }]],
    });
    const result = await resolveWorkAddressLocation(client, "co-1", undefined);
    expect(result).toEqual({ ok: true, data: { locationUuid: "loc-1" } });
  });

  test("blocks with an actionable reason when the company has no locations", async () => {
    const { client } = stubApiClient({ "GET /v1/companies/co-1/locations": [200, []] });
    const result = await resolveWorkAddressLocation(client, "co-1", undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("validation");
    expect(result.error.blocked_on?.map((b) => b.field)).toEqual(["location-uuid"]);
    expect(result.error.blocked_on?.[0]?.reason).toContain("no company locations found");
    expect(result.error.blocked_on?.[0]?.reason).toContain("company setup address");
  });

  test("propagates the malformed_response envelope when /locations returns a non-array body", async () => {
    const { client } = stubApiClient({ "GET /v1/companies/co-1/locations": [200, { not: "an array" }] });
    const result = await resolveWorkAddressLocation(client, "co-1", undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("malformed_response");
  });
});

describe("jobBlockers", () => {
  test("flags missing title and hire-date", () => {
    expect(jobBlockers({}).map((b) => b.field)).toEqual(["title", "hire-date"]);
  });

  test("accepts a job with no compensation", () => {
    expect(jobBlockers({ title: "Engineer", hireDate: "2026-01-06" })).toEqual([]);
  });

  test("partial compensation requires the rest (rate without unit/flsa)", () => {
    const fields = jobBlockers({ title: "Engineer", hireDate: "2026-01-06", rate: "120000" }).map((b) => b.field);
    expect(fields).toContain("payment-unit");
    expect(fields).toContain("flsa-status");
  });
});

describe("jobBody / compensationBody", () => {
  test("jobBody is {title, hire_date}", () => {
    expect(jobBody({ title: "Engineer", hireDate: "2026-01-06" })).toEqual({
      title: "Engineer",
      hire_date: "2026-01-06",
    });
  });

  test("compensationBody is undefined when no comp flags are present", () => {
    expect(compensationBody({ title: "Engineer", hireDate: "2026-01-06" })).toBeUndefined();
  });

  test("compensationBody maps the three comp flags to snake_case", () => {
    expect(compensationBody({ rate: "120000", paymentUnit: "Year", flsaStatus: "Exempt" })).toEqual({
      rate: "120000",
      payment_unit: "Year",
      flsa_status: "Exempt",
    });
  });
});

describe("runJob", () => {
  test("creates the job only when no compensation is requested", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [201, { uuid: "job-7" }],
    });
    const result = await runJob(client, "emp-1", { title: "Engineer", hireDate: "2026-01-06" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(["job"]);
    expect(calls.every((c) => c.method === "POST")).toBe(true);
  });

  test("updates the job's current compensation in place (no orphan POST) carrying its version", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [
        201,
        { uuid: "job-7", current_compensation_uuid: "comp-9", compensations: [{ uuid: "comp-9", version: "v-comp" }] },
      ],
      "PUT /v1/compensations/comp-9": [200, { uuid: "comp-9", rate: "120000.00" }],
    });
    const result = await runJob(client, "emp-1", {
      title: "Engineer",
      hireDate: "2026-01-06",
      rate: "120000",
      paymentUnit: "Year",
      flsaStatus: "Exempt",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(["job", "compensation"]);
    const compCall = calls.find((c) => c.url.startsWith("/v1/compensations/"));
    expect(compCall?.method).toBe("PUT");
    expect(compCall?.url).toBe("/v1/compensations/comp-9");
    expect((compCall?.body as Record<string, unknown>).version).toBe("v-comp");
    expect(calls.some((c) => c.url.includes("/compensations") && c.method === "POST")).toBe(false);
  });

  test("refetches the job when the POST response lacks a current compensation, then PUTs the comp", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [201, { uuid: "job-7" }],
      "GET /v1/jobs/job-7": [
        200,
        { uuid: "job-7", current_compensation_uuid: "comp-9", compensations: [{ uuid: "comp-9", version: "v-comp" }] },
      ],
      "PUT /v1/compensations/comp-9": [200, { uuid: "comp-9", rate: "120000.00" }],
    });
    const result = await runJob(client, "emp-1", {
      title: "Engineer",
      hireDate: "2026-01-06",
      rate: "120000",
      paymentUnit: "Year",
      flsaStatus: "Exempt",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(["job", "compensation"]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /v1/employees/emp-1/jobs",
      "GET /v1/jobs/job-7",
      "PUT /v1/compensations/comp-9",
    ]);
  });

  test("retries GET when the comp pointer is missing and PUTs once it surfaces", async () => {
    const getResponses: [number, unknown][] = [
      [200, { uuid: "job-7" }],
      [200, { uuid: "job-7" }],
      [
        200,
        { uuid: "job-7", current_compensation_uuid: "comp-9", compensations: [{ uuid: "comp-9", version: "v-comp" }] },
      ],
    ];
    const calls: { method: string; url: string }[] = [];
    let getIdx = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(url.toString());
      const method = init?.method ?? "GET";
      calls.push({ method, url: u.pathname });
      if (method === "POST" && u.pathname === "/v1/employees/emp-1/jobs") {
        return new Response(JSON.stringify({ uuid: "job-7" }), { status: 201 });
      }
      if (method === "GET" && u.pathname === "/v1/jobs/job-7") {
        const [s, b] = getResponses[Math.min(getIdx++, getResponses.length - 1)];
        return new Response(JSON.stringify(b), { status: s });
      }
      if (method === "PUT" && u.pathname === "/v1/compensations/comp-9") {
        return new Response(JSON.stringify({ uuid: "comp-9", rate: "120000.00" }), { status: 200 });
      }
      throw new Error(`unexpected ${method} ${u.pathname}`);
    }) as unknown as typeof fetch;
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      token: "tok",
      apiVersion: "2026-02-01",
      fetchImpl,
      retrySleepMs: () => 0,
    });
    const result = await runJob(
      client,
      "emp-1",
      { title: "Engineer", hireDate: "2026-01-06", rate: "120000", paymentUnit: "Year", flsaStatus: "Exempt" },
      [0, 0, 0],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /v1/employees/emp-1/jobs",
      "GET /v1/jobs/job-7",
      "GET /v1/jobs/job-7",
      "GET /v1/jobs/job-7",
      "PUT /v1/compensations/comp-9",
    ]);
  });

  test("exhausts retries without ever deleting the job and surfaces job_created_without_compensation", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [201, { uuid: "job-7" }],
      "GET /v1/jobs/job-7": [200, { uuid: "job-7" }],
    });
    const result = await runJob(
      client,
      "emp-1",
      { title: "Engineer", hireDate: "2026-01-06", rate: "120000", paymentUnit: "Year", flsaStatus: "Exempt" },
      [0, 0, 0],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("job_created_without_compensation");
    expect(calls.map((c) => `${c.method} ${c.url}`)).not.toContain("DELETE /v1/jobs/job-7");
    const details = result.error.details as { job: { uuid: string }; job_uuid: string };
    expect(details.job_uuid).toBe("job-7");
    // POST + 3 GETs, no DELETE
    expect(calls.filter((c) => c.method === "GET" && c.url === "/v1/jobs/job-7")).toHaveLength(3);
  });

  test("retries exhaust the full delay schedule even when GET returns a sparse body without uuid", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [201, { uuid: "job-7" }],
      "GET /v1/jobs/job-7": [200, {}],
    });
    const result = await runJob(
      client,
      "emp-1",
      { title: "Engineer", hireDate: "2026-01-06", rate: "120000", paymentUnit: "Year", flsaStatus: "Exempt" },
      [0, 0, 0],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("job_created_without_compensation");
    // The stable jobUuid from the POST response is preserved in details even though
    // the latest GET body is empty, so the user can still recover manually.
    const details = result.error.details as { job_uuid: string };
    expect(details.job_uuid).toBe("job-7");
    // All three GETs ran - the sparse body didn't short-circuit the retry loop.
    expect(calls.filter((c) => c.method === "GET" && c.url === "/v1/jobs/job-7")).toHaveLength(3);
  });

  test("when the refetch GET fails (network / 5xx), surfaces a check-failed error WITHOUT deleting the job", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [201, { uuid: "job-7" }],
      "GET /v1/jobs/job-7": [500, { error: "transient" }],
    });
    const result = await runJob(
      client,
      "emp-1",
      { title: "Engineer", hireDate: "2026-01-06", rate: "120000", paymentUnit: "Year", flsaStatus: "Exempt" },
      [0, 0, 0],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("job_compensation_check_failed");
    expect(calls.map((c) => `${c.method} ${c.url}`)).not.toContain("DELETE /v1/jobs/job-7");
    const details = result.error.details as { job: { uuid: string }; check_error: string };
    expect(details.job.uuid).toBe("job-7");
    expect(details.check_error).toBeTruthy();
  });

  test("a job POST failure surfaces the API error", async () => {
    const { client } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [422, { error: "bad hire_date" }],
    });
    const result = await runJob(client, "emp-1", { title: "Engineer", hireDate: "not-a-date" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });

  test("a compensation PUT failure surfaces the created job so a retry targets it (no duplicate job)", async () => {
    const { client } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [
        201,
        { uuid: "job-7", current_compensation_uuid: "comp-9", compensations: [{ uuid: "comp-9", version: "v-comp" }] },
      ],
      "PUT /v1/compensations/comp-9": [422, { error: "bad rate" }],
    });
    const result = await runJob(client, "emp-1", {
      title: "Engineer",
      hireDate: "2026-01-06",
      rate: "nope",
      paymentUnit: "Year",
      flsaStatus: "Exempt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("compensation_failed");
    const details = result.error.details as { job: { uuid: string }; completed: string[]; failed: { domain: string } };
    expect(details.job.uuid).toBe("job-7");
    expect(details.completed).toEqual(["job"]);
    expect(details.failed.domain).toBe("compensation");
  });
});

describe("federalTaxBlockers", () => {
  test("requires filing-status", () => {
    expect(federalTaxBlockers({}).map((b) => b.field)).toEqual(["filing-status"]);
  });

  test("accepts a filing status", () => {
    expect(federalTaxBlockers({ filingStatus: "Single" })).toEqual([]);
  });
});

describe("federalTaxBody", () => {
  test("minimal body is just filing_status", () => {
    expect(federalTaxBody({ filingStatus: "Single" })).toEqual({ filing_status: "Single" });
  });

  test("maps the optional W-4 flags to snake_case when present", () => {
    expect(
      federalTaxBody({ filingStatus: "Single", w4DataType: "rev_2020_w4", twoJobs: true, extraWithholding: "50" }),
    ).toMatchObject({ w4_data_type: "rev_2020_w4", two_jobs: true, extra_withholding: "50" });
  });
});

describe("runFederalTax", () => {
  test("GETs the current version before the PUT (avoids a 409) and sends filing_status", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v1", filing_status: null }],
      "PUT /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v2", filing_status: "Single" }],
    });
    const result = await runFederalTax(client, "emp-1", { filingStatus: "Single" });
    expect(result.ok).toBe(true);
    const seq = calls.map((c) => `${c.method} ${c.url}`);
    expect(seq.indexOf("GET /v1/employees/emp-1/federal_taxes")).toBeLessThan(
      seq.indexOf("PUT /v1/employees/emp-1/federal_taxes"),
    );
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as Record<string, unknown>).version).toBe("fed-v1");
    expect((put?.body as Record<string, unknown>).filing_status).toBe("Single");
  });

  test("a PUT failure surfaces the API error", async () => {
    const { client } = stubApiClient({
      "GET /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v1" }],
      "PUT /v1/employees/emp-1/federal_taxes": [422, { error: "invalid filing_status" }],
    });
    const result = await runFederalTax(client, "emp-1", { filingStatus: "Nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });

  test("carries over every unset W-4 field on a partial update (the PUT replaces the record)", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/federal_taxes": [
        200,
        {
          version: "fed-v1",
          w4_data_type: "rev_2020_w4",
          two_jobs: true,
          dependents_amount: "2000.0",
          other_income: "500.0",
          extra_withholding: "50.0",
          deductions: "100.0",
        },
      ],
      "PUT /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v2" }],
    });
    // Only --filing-status changes; the rest must be carried over, not zeroed.
    const result = await runFederalTax(client, "emp-1", { filingStatus: "Married" });
    expect(result.ok).toBe(true);
    const body = calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>;
    expect(body.filing_status).toBe("Married");
    expect(body).toMatchObject({
      w4_data_type: "rev_2020_w4",
      two_jobs: true,
      dependents_amount: "2000.0",
      other_income: "500.0",
      extra_withholding: "50.0",
      deductions: "100.0",
    });
  });

  test("an explicit --w4-data-type overrides the current value", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v1", w4_data_type: "rev_2020_w4" }],
      "PUT /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v2" }],
    });
    await runFederalTax(client, "emp-1", { filingStatus: "Single", w4DataType: "pre_2020_w4" });
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as Record<string, unknown>).w4_data_type).toBe("pre_2020_w4");
  });

  // A fresh rev_2020_w4 record has no values for the four numeric W-4 fields, so a
  // `--filing-status`-only PUT 422s ("...should be a number"). Default them to "0" so the common
  // case works without forcing the caller to pass --other-income 0 --extra-withholding 0 ... etc.
  test("defaults the 2020 W-4 numeric fields to 0 on a fresh record", async () => {
    const { client, calls } = stubApiClient({
      // Fresh record: a version but none of the numeric fields set yet.
      "GET /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v1" }],
      "PUT /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v2" }],
    });
    const result = await runFederalTax(client, "emp-1", { filingStatus: "Single", w4DataType: "rev_2020_w4" });
    expect(result.ok).toBe(true);
    const body = calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      dependents_amount: "0",
      other_income: "0",
      extra_withholding: "0",
      deductions: "0",
    });
  });

  test("a null numeric W-4 field on the current record is defaulted to 0 (not carried as null)", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/federal_taxes": [
        200,
        { version: "fed-v1", w4_data_type: "rev_2020_w4", other_income: null },
      ],
      "PUT /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v2" }],
    });
    await runFederalTax(client, "emp-1", { filingStatus: "Single" });
    const body = calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>;
    expect(body.other_income).toBe("0");
  });

  test("an explicitly-passed numeric W-4 flag is not overwritten by the 0 default", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v1" }],
      "PUT /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v2" }],
    });
    await runFederalTax(client, "emp-1", { filingStatus: "Single", w4DataType: "rev_2020_w4", otherIncome: "500.0" });
    const body = calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>;
    expect(body.other_income).toBe("500.0");
  });

  test("does not inject the 2020 numeric fields for a pre_2020_w4 form", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v1" }],
      "PUT /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v2" }],
    });
    await runFederalTax(client, "emp-1", { filingStatus: "Single", w4DataType: "pre_2020_w4" });
    const body = calls.find((c) => c.method === "PUT")?.body as Record<string, unknown>;
    expect(body.other_income).toBeUndefined();
    expect(body.dependents_amount).toBeUndefined();
    expect(body.deductions).toBeUndefined();
  });
});

describe("paymentMethodBlockers", () => {
  test("requires a type", () => {
    expect(paymentMethodBlockers({}).map((b) => b.field)).toEqual(["type"]);
  });

  test("rejects an unknown type", () => {
    expect(paymentMethodBlockers({ type: "venmo" }).map((b) => b.field)).toEqual(["type"]);
  });

  test("check needs nothing else", () => {
    expect(paymentMethodBlockers({ type: "check" })).toEqual([]);
  });

  test("direct-deposit requires the bank-account fields", () => {
    const fields = paymentMethodBlockers({ type: "direct-deposit" }).map((b) => b.field);
    expect(fields).toEqual(["name", "routing-number", "account-number", "account-type"]);
  });

  test("direct-deposit rejects a bad account-type", () => {
    const fields = paymentMethodBlockers({
      type: "direct-deposit",
      name: "Checking",
      routingNumber: "266905059",
      accountNumber: "5809431207",
      accountType: "Crypto",
    }).map((b) => b.field);
    expect(fields).toEqual(["account-type"]);
  });

  test("a complete direct-deposit passes", () => {
    expect(
      paymentMethodBlockers({
        type: "direct-deposit",
        name: "Checking",
        routingNumber: "266905059",
        accountNumber: "5809431207",
        accountType: "Checking",
      }),
    ).toEqual([]);
  });
});

describe("runPaymentMethod", () => {
  test("check → version-guarded PUT with type Check", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/payment_method": [200, { version: "pm-v1", type: "Check" }],
      "PUT /v1/employees/emp-1/payment_method": [200, { type: "Check" }],
    });
    const result = await runPaymentMethod(client, "emp-1", { type: "check" });
    expect(result.ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as Record<string, unknown>).type).toBe("Check");
    expect((put?.body as Record<string, unknown>).version).toBe("pm-v1");
    expect(calls.some((c) => c.url.includes("/bank_accounts"))).toBe(false);
  });

  test("direct-deposit → create bank account, then PUT Direct Deposit split to it", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/employees/emp-1/bank_accounts": [201, { uuid: "bank-1" }],
      "GET /v1/employees/emp-1/payment_method": [200, { version: "pm-v1" }],
      "PUT /v1/employees/emp-1/payment_method": [200, { type: "Direct Deposit" }],
    });
    const result = await runPaymentMethod(client, "emp-1", {
      type: "direct-deposit",
      name: "Checking",
      routingNumber: "266905059",
      accountNumber: "5809431207",
      accountType: "Checking",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(["bank_account", "payment_method"]);
    const post = calls.find((c) => c.url.endsWith("/bank_accounts"));
    expect((post?.body as Record<string, unknown>).routing_number).toBe("266905059");
    const put = calls.find((c) => c.method === "PUT");
    const body = put?.body as { type: string; splits: { uuid: string; split_amount: number }[] };
    expect(body.type).toBe("Direct Deposit");
    expect(body.splits[0]?.uuid).toBe("bank-1");
    expect(body.splits[0]?.split_amount).toBe(100);
  });

  test("direct-deposit errors when the bank account create returns no uuid", async () => {
    const { client } = stubApiClient({
      "POST /v1/employees/emp-1/bank_accounts": [201, { routing_number: "266905059" }],
    });
    const result = await runPaymentMethod(client, "emp-1", {
      type: "direct-deposit",
      name: "Checking",
      routingNumber: "266905059",
      accountNumber: "5809431207",
      accountType: "Checking",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("bank_create_no_uuid");
  });

  test("a payment_method PUT failure surfaces the created bank account so a retry reuses it (no duplicate)", async () => {
    const { client } = stubApiClient({
      "POST /v1/employees/emp-1/bank_accounts": [201, { uuid: "bank-1" }],
      "GET /v1/employees/emp-1/payment_method": [200, { version: "pm-v1" }],
      "PUT /v1/employees/emp-1/payment_method": [422, { error: "bad split" }],
    });
    const result = await runPaymentMethod(client, "emp-1", {
      type: "direct-deposit",
      name: "Checking",
      routingNumber: "266905059",
      accountNumber: "5809431207",
      accountType: "Checking",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("payment_method_failed");
    const details = result.error.details as {
      bank_account: { uuid: string };
      completed: string[];
      failed: { domain: string };
    };
    expect(details.bank_account.uuid).toBe("bank-1");
    expect(details.completed).toEqual(["bank_account"]);
    expect(details.failed.domain).toBe("payment_method");
  });
});

// Fixtures mirror the real GET /v1/employees/{uuid}/state_taxes responses captured from the sandbox.
const CA_STATE = {
  state: "CA",
  is_work_state: true,
  questions: [
    {
      key: "filing_status",
      label: "Filing Status",
      input_question_format: {
        type: "Select",
        options: [
          { value: "S", label: "Single" },
          { value: "M", label: "Married one income" },
          { value: "H", label: "Head of Household" },
        ],
      },
      answers: [],
    },
    {
      key: "withholding_allowance",
      label: "Withholding Allowance",
      input_question_format: { type: "Number" },
      answers: [],
    },
    {
      key: "additional_withholding",
      label: "Additional Withholding",
      input_question_format: { type: "Currency" },
      answers: [{ value: "0.0" }],
    },
  ],
};
const TX_STATE = { state: "TX", is_work_state: true, questions: [] };

describe("parseAnswerFlags", () => {
  test("an unscoped answer has no state", () => {
    expect(parseAnswerFlags(["filing_status=Single"])).toEqual({
      ok: true,
      answers: [{ key: "filing_status", value: "Single" }],
    });
  });

  test("a STATE:key=value answer is state-scoped", () => {
    expect(parseAnswerFlags(["NY:filing_status=Single"])).toEqual({
      ok: true,
      answers: [{ state: "NY", key: "filing_status", value: "Single" }],
    });
  });

  test("only the first = splits key from value (values may contain =)", () => {
    expect(parseAnswerFlags(["k=a=b"])).toEqual({ ok: true, answers: [{ key: "k", value: "a=b" }] });
  });

  test("a flag with no = is rejected", () => {
    const r = parseAnswerFlags(["bogus"]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.blocked[0]?.field).toBe("answer");
  });
});

describe("buildStateTaxBody", () => {
  test("maps a Select human label to its value and passes a Number through", () => {
    const r = buildStateTaxBody(
      [CA_STATE],
      [
        { key: "filing_status", value: "Single" },
        { key: "withholding_allowance", value: "2" },
      ],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.body).toEqual({
      states: [
        {
          state: "CA",
          questions: [
            { key: "filing_status", answers: [{ value: "S" }] },
            { key: "withholding_allowance", answers: [{ value: "2" }] },
          ],
        },
      ],
    });
  });

  test("a Select value (not just label) is accepted", () => {
    const r = buildStateTaxBody(
      [CA_STATE],
      [
        { key: "filing_status", value: "S" },
        { key: "withholding_allowance", value: "1" },
      ],
    );
    expect(r.ok).toBe(true);
  });

  // Some Select questions list boolean (or numeric) option values in discovery, e.g.
  // file_new_hire_report → { value: true, label: "Yes, file..." }. The CLI must accept the listed
  // value, coerce it for matching, and PUT it back with its original (boolean) type.
  const NEW_HIRE_STATE = {
    state: "CA",
    questions: [
      {
        key: "file_new_hire_report",
        label: "File new hire report",
        input_question_format: {
          type: "Select",
          options: [
            { value: true, label: "Yes, file the state new hire report for me." },
            { value: false, label: "No, I have already filed." },
          ],
        },
        answers: [],
      },
    ],
  };

  test("a boolean Select value is accepted and preserved as a boolean in the body", () => {
    const r = buildStateTaxBody(NEW_HIRE_STATE.questions ? [NEW_HIRE_STATE] : [], [
      { state: "CA", key: "file_new_hire_report", value: "true" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.body.states[0]?.questions[0]?.answers[0]?.value).toBe(true);
  });

  test("a boolean Select question still accepts the human label", () => {
    const r = buildStateTaxBody(
      [NEW_HIRE_STATE],
      [{ state: "CA", key: "file_new_hire_report", value: "No, I have already filed." }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.body.states[0]?.questions[0]?.answers[0]?.value).toBe(false);
  });

  test("an unmatched value for a boolean Select is blocked", () => {
    const r = buildStateTaxBody([NEW_HIRE_STATE], [{ state: "CA", key: "file_new_hire_report", value: "maybe" }]);
    expect(r.ok).toBe(false);
  });

  test("a boolean Select accepts Yes/No as aliases for true/false", () => {
    const yes = buildStateTaxBody([NEW_HIRE_STATE], [{ state: "CA", key: "file_new_hire_report", value: "Yes" }]);
    expect(yes.ok).toBe(true);
    if (!yes.ok) throw new Error("unreachable");
    expect(yes.body.states[0]?.questions[0]?.answers[0]?.value).toBe(true);

    const no = buildStateTaxBody([NEW_HIRE_STATE], [{ state: "CA", key: "file_new_hire_report", value: "no" }]);
    expect(no.ok).toBe(true);
    if (!no.ok) throw new Error("unreachable");
    expect(no.body.states[0]?.questions[0]?.answers[0]?.value).toBe(false);
  });

  test("Yes/No alias does not apply to non-boolean Select questions", () => {
    const yesNoOptionsState = {
      state: "NY",
      questions: [
        {
          key: "yn",
          input_question_format: {
            type: "Select",
            options: [
              { value: "Y", label: "Yes" },
              { value: "N", label: "No" },
            ],
          },
          answers: [],
        },
      ],
    };
    const r = buildStateTaxBody([yesNoOptionsState], [{ state: "NY", key: "yn", value: "Yes" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.body.states[0]?.questions[0]?.answers[0]?.value).toBe("Y");
  });

  test("a missing required question is blocked with STATE:key", () => {
    const r = buildStateTaxBody([CA_STATE], [{ key: "filing_status", value: "Single" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.blocked.map((b) => b.field)).toContain("CA:withholding_allowance");
  });

  test("an invalid Select choice is blocked and echoes the allowed labels", () => {
    const r = buildStateTaxBody(
      [CA_STATE],
      [
        { key: "filing_status", value: "Nope" },
        { key: "withholding_allowance", value: "2" },
      ],
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    const fs = r.blocked.find((b) => b.field === "CA:filing_status");
    expect(fs?.reason).toMatch(/Single/);
  });

  test("an unknown answer key is rejected", () => {
    const r = buildStateTaxBody(
      [CA_STATE],
      [
        { key: "filing_status", value: "Single" },
        { key: "withholding_allowance", value: "2" },
        { key: "made_up", value: "x" },
      ],
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.blocked.some((b) => b.field === "made_up")).toBe(true);
  });

  test("a state with no questions (TX) needs no answers and yields an empty body", () => {
    const r = buildStateTaxBody([TX_STATE], []);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.body.states).toEqual([]);
  });

  test("an unscoped answer fills every state with that key; a scoped answer overrides one", () => {
    const opts = {
      type: "Select",
      options: [
        { value: "S", label: "Single" },
        { value: "M", label: "Married" },
      ],
    };
    const ny = { state: "NY", questions: [{ key: "filing_status", input_question_format: opts, answers: [] }] };
    const nj = { state: "NJ", questions: [{ key: "filing_status", input_question_format: opts, answers: [] }] };
    const r = buildStateTaxBody(
      [ny, nj],
      [
        { key: "filing_status", value: "Single" },
        { state: "NJ", key: "filing_status", value: "Married" },
      ],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const byState = Object.fromEntries(r.body.states.map((s) => [s.state, s.questions[0]?.answers[0]?.value]));
    expect(byState).toEqual({ NY: "S", NJ: "M" });
  });

  // A state with required Number / Currency / Date questions, to exercise resolveAnswerValue's
  // non-Select format checks.
  const TYPED_STATE = {
    state: "ZZ",
    questions: [
      { key: "num_q", input_question_format: { type: "Number" }, answers: [] },
      { key: "cur_q", input_question_format: { type: "Currency" }, answers: [] },
      { key: "date_q", input_question_format: { type: "Date" }, answers: [] },
    ],
  };

  test("Number, Currency, and Date answers pass through when well-formed", () => {
    const r = buildStateTaxBody(
      [TYPED_STATE],
      [
        { key: "num_q", value: "5" },
        { key: "cur_q", value: "10.50" },
        { key: "date_q", value: "2026-01-01" },
      ],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const answers = Object.fromEntries(r.body.states[0]!.questions.map((q) => [q.key, q.answers[0]?.value]));
    expect(answers).toEqual({ num_q: "5", cur_q: "10.50", date_q: "2026-01-01" });
  });

  test("a non-numeric Number is blocked", () => {
    const r = buildStateTaxBody(
      [TYPED_STATE],
      [
        { key: "num_q", value: "abc" },
        { key: "cur_q", value: "0" },
        { key: "date_q", value: "2026-01-01" },
      ],
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.blocked.find((b) => b.field === "ZZ:num_q")?.reason).toMatch(/number/i);
  });

  test("a non-numeric Currency is blocked", () => {
    const r = buildStateTaxBody(
      [TYPED_STATE],
      [
        { key: "num_q", value: "1" },
        { key: "cur_q", value: "ten dollars" },
        { key: "date_q", value: "2026-01-01" },
      ],
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.blocked.find((b) => b.field === "ZZ:cur_q")?.reason).toMatch(/number/i);
  });

  test("a malformed Date (not YYYY-MM-DD) is blocked", () => {
    const r = buildStateTaxBody(
      [TYPED_STATE],
      [
        { key: "num_q", value: "1" },
        { key: "cur_q", value: "0" },
        { key: "date_q", value: "not-a-date" },
      ],
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.blocked.find((b) => b.field === "ZZ:date_q")?.reason).toMatch(/date/i);
  });
});

describe("introspectStateTax", () => {
  test("returns the rendered questions and the list of answers still needed", async () => {
    const { client } = stubApiClient({ "GET /v1/employees/emp-1/state_taxes": [200, [CA_STATE, TX_STATE]] });
    const result = await introspectStateTax(client, "emp-1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const data = result.data as {
      states: { state: string; questions: { key: string; required: boolean }[] }[];
      answers_needed: string[];
    };
    expect(data.answers_needed).toEqual(["CA:filing_status", "CA:withholding_allowance"]);
    const ca = data.states.find((s) => s.state === "CA");
    expect(ca?.questions.find((q) => q.key === "filing_status")).toMatchObject({ required: true });
  });
});

describe("runStateTax", () => {
  test("GETs questions, maps answers, and PUTs the body", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/state_taxes": [200, [CA_STATE]],
      "PUT /v1/employees/emp-1/state_taxes": [200, [{ state: "CA" }]],
    });
    const result = await runStateTax(client, "emp-1", [
      { key: "filing_status", value: "Single" },
      { key: "withholding_allowance", value: "2" },
    ]);
    expect(result.ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    const body = put?.body as {
      states: { state: string; questions: { key: string; answers: { value: string }[] }[] }[];
    };
    expect(body.states[0]?.questions.find((q) => q.key === "filing_status")?.answers[0]?.value).toBe("S");
  });

  test("missing required answers block (exit 7) without PUTting", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/state_taxes": [200, [CA_STATE]],
    });
    const result = await runStateTax(client, "emp-1", [{ key: "filing_status", value: "Single" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("a failure GETting the questions surfaces the API error", async () => {
    const { client } = stubApiClient({ "GET /v1/employees/emp-1/state_taxes": [500, { error: "boom" }] });
    const result = await runStateTax(client, "emp-1", [{ key: "filing_status", value: "Single" }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
  });

  test("a PUT failure surfaces the API error", async () => {
    const { client } = stubApiClient({
      "GET /v1/employees/emp-1/state_taxes": [200, [CA_STATE]],
      "PUT /v1/employees/emp-1/state_taxes": [422, { error: "invalid filing_status" }],
    });
    const result = await runStateTax(client, "emp-1", [
      { key: "filing_status", value: "Single" },
      { key: "withholding_allowance", value: "2" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });

  test("a state set with nothing to answer (e.g. TX-only) is a no-op success and never PUTs", async () => {
    const { client, calls } = stubApiClient({ "GET /v1/employees/emp-1/state_taxes": [200, [TX_STATE]] });
    const result = await runStateTax(client, "emp-1", []);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const data = result.data as { message: string; states: unknown[] };
    expect(data.message).toMatch(/no state-tax answers needed/);
    expect(data.states).toHaveLength(1);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("dry-run GETs and builds the body but never PUTs", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/state_taxes": [200, [CA_STATE]],
    });
    const result = await runStateTax(
      client,
      "emp-1",
      [
        { key: "filing_status", value: "Single" },
        { key: "withholding_allowance", value: "2" },
      ],
      true,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const data = result.data as { method: string; path: string; body: unknown };
    expect(data.method).toBe("PUT");
    expect(data.path).toBe("/v1/employees/emp-1/state_taxes");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

// `employee manage <uuid>` updates an existing employee's identity (name/SSN/DOB, version-guarded
// PUT /v1/employees/{uuid}) and/or switches onboarding mode (--mode admin|invite, PUT
// /v1/employees/{uuid}/onboarding_status). Both may be passed in one call.

describe("manageIdentityBody", () => {
  test("maps only the supplied identity flags to snake_case", () => {
    expect(manageIdentityBody({ ssn: "123-45-6789", dateOfBirth: "1990-01-01" })).toEqual({
      ssn: "123-45-6789",
      date_of_birth: "1990-01-01",
    });
  });

  test("includes name fields when present", () => {
    expect(manageIdentityBody({ firstName: "Jane", lastName: "Doe" })).toEqual({
      first_name: "Jane",
      last_name: "Doe",
    });
  });

  test("is empty when no identity flag is passed", () => {
    expect(manageIdentityBody({ mode: "admin" })).toEqual({});
  });
});

describe("resolveManageMode", () => {
  test("--mode admin selects admin_onboarding_incomplete", () => {
    expect(resolveManageMode({ mode: "admin" })).toEqual({ ok: true, status: "admin_onboarding_incomplete" });
  });

  test("--mode invite selects self_onboarding_pending_invite", () => {
    expect(resolveManageMode({ mode: "invite" })).toEqual({ ok: true, status: "self_onboarding_pending_invite" });
  });

  test("no --mode yields a null status (no mode change)", () => {
    expect(resolveManageMode({ ssn: "123-45-6789" })).toEqual({ ok: true, status: null });
  });

  test("an unknown --mode value is blocked", () => {
    const r = resolveManageMode({ mode: "bogus" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.blocked[0]?.field).toBe("mode");
  });
});

describe("manageBlockers", () => {
  test("nothing to manage is blocked", () => {
    expect(manageBlockers({}).map((b) => b.field)).toEqual(["fields"]);
  });

  test("an unknown --mode value is blocked", () => {
    expect(manageBlockers({ mode: "bogus" }).map((b) => b.field)).toEqual(["mode"]);
  });

  test("an identity-only call is allowed", () => {
    expect(manageBlockers({ ssn: "123-45-6789" })).toEqual([]);
  });

  test("a mode-only call is allowed", () => {
    expect(manageBlockers({ mode: "admin" })).toEqual([]);
  });

  test("a mixed identity + mode call is allowed", () => {
    expect(manageBlockers({ firstName: "Jane", mode: "invite" })).toEqual([]);
  });
});

describe("runManage", () => {
  test("identity only → version-guarded PUT to the employee, no onboarding_status call", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1": [200, { version: "emp-v1" }],
      "PUT /v1/employees/emp-1": [200, { version: "emp-v2", uuid: "emp-1" }],
    });
    const result = await runManage(client, "emp-1", { ssn: "123-45-6789", dateOfBirth: "1990-01-01" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(["employee"]);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/v1/employees/emp-1");
    expect(put?.body).toMatchObject({ ssn: "123-45-6789", date_of_birth: "1990-01-01", version: "emp-v1" });
    expect(calls.some((c) => c.url.includes("/onboarding_status"))).toBe(false);
  });

  test("mode only (--mode admin) → PUTs onboarding_status, never touches the employee record", async () => {
    const { client, calls } = stubApiClient({
      "PUT /v1/employees/emp-1/onboarding_status": [200, { onboarding_status: "admin_onboarding_incomplete" }],
    });
    const result = await runManage(client, "emp-1", { mode: "admin" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(["onboarding_status"]);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/v1/employees/emp-1/onboarding_status");
    expect(put?.body).toEqual({ onboarding_status: "admin_onboarding_incomplete" });
    expect(calls.some((c) => c.url === "/v1/employees/emp-1")).toBe(false);
  });

  test("mixed → switches onboarding mode first, then version-guards the identity PUT", async () => {
    const { client, calls } = stubApiClient({
      "PUT /v1/employees/emp-1/onboarding_status": [200, { onboarding_status: "admin_onboarding_incomplete" }],
      "GET /v1/employees/emp-1": [200, { version: "emp-v1" }],
      "PUT /v1/employees/emp-1": [200, { version: "emp-v2" }],
    });
    const result = await runManage(client, "emp-1", { mode: "admin", ssn: "123-45-6789" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(["onboarding_status", "employee"]);
    // The onboarding_status PUT must precede the employee PUT.
    const puts = calls.filter((c) => c.method === "PUT").map((c) => c.url);
    expect(puts).toEqual(["/v1/employees/emp-1/onboarding_status", "/v1/employees/emp-1"]);
  });

  test("a mode-only API error is surfaced as-is", async () => {
    const { client } = stubApiClient({
      "PUT /v1/employees/emp-1/onboarding_status": [422, { error: "invalid transition" }],
    });
    const result = await runManage(client, "emp-1", { mode: "admin" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });

  test("mode succeeds but the identity PUT fails → reports the completed mode switch for a clean retry", async () => {
    const { client } = stubApiClient({
      "PUT /v1/employees/emp-1/onboarding_status": [200, { onboarding_status: "admin_onboarding_incomplete" }],
      "GET /v1/employees/emp-1": [200, { version: "emp-v1" }],
      "PUT /v1/employees/emp-1": [422, { error: "bad ssn" }],
    });
    const result = await runManage(client, "emp-1", { mode: "admin", ssn: "bad" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("manage_identity_failed");
    const details = result.error.details as { completed: string[]; failed: { domain: string } };
    expect(details.completed).toEqual(["onboarding_status"]);
    expect(details.failed.domain).toBe("employee");
  });

  test("an unknown --mode value blocks before any call", async () => {
    const { client, calls } = stubApiClient({});
    const result = await runManage(client, "emp-1", { mode: "bogus" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(calls.length).toBe(0);
  });
});
