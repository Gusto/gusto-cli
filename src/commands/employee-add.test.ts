import { describe, expect, test } from "bun:test";
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
  parseAnswerFlags,
  paymentMethodBlockers,
  runFederalTax,
  runJob,
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
  test("flags missing location-uuid and effective-date", () => {
    expect(workAddressBlockers({}).map((b) => b.field)).toEqual(["location-uuid", "effective-date"]);
  });

  test("accepts a complete work address", () => {
    expect(workAddressBlockers({ locationUuid: "loc-1", effectiveDate: "2026-01-01" })).toEqual([]);
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

  test("errors clearly when the created job has no current compensation to update", async () => {
    const { client } = stubApiClient({
      "POST /v1/employees/emp-1/jobs": [201, { uuid: "job-7" }],
    });
    const result = await runJob(client, "emp-1", {
      title: "Engineer",
      hireDate: "2026-01-06",
      rate: "120000",
      paymentUnit: "Year",
      flsaStatus: "Exempt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("job_no_current_compensation");
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

  test("carries over the current w4_data_type when --w4-data-type is omitted (the PUT requires it)", async () => {
    const { client, calls } = stubApiClient({
      "GET /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v1", w4_data_type: "rev_2020_w4" }],
      "PUT /v1/employees/emp-1/federal_taxes": [200, { version: "fed-v2" }],
    });
    const result = await runFederalTax(client, "emp-1", { filingStatus: "Married" });
    expect(result.ok).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as Record<string, unknown>).w4_data_type).toBe("rev_2020_w4");
    expect((put?.body as Record<string, unknown>).filing_status).toBe("Married");
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
