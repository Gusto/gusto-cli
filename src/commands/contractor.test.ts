import { afterEach, describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import { pagedRouter, stubApiClient, stubGlobalFetch, TEST_AUTH, TEST_CONTEXT } from "../lib/test-support.ts";
import {
  contractorListHandler,
  contractorSelfOnboardSteps,
  runContractorAdd,
  validateContractorAdd,
} from "./contractor.ts";

const SELF_ONBOARD_INDIVIDUAL = {
  type: "Individual" as const,
  first_name: "Sam",
  last_name: "Rivera",
  start_date: "2026-06-03",
  wage_type: "Fixed" as const,
  self_onboarding: true as const,
  email: "sam@example.com",
};

describe("validateContractorAdd", () => {
  test("individual with all required fields returns the populated body", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "2026-06-03",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        type: "Individual",
        first_name: "Sam",
        last_name: "Rivera",
        email: "s@x.com",
        wage_type: "Fixed",
        start_date: "2026-06-03",
        self_onboarding: false,
      },
    });
  });

  test("self_onboarding defaults to false and is true only when opted in", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "2026-06-03",
      selfOnboarding: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.self_onboarding).toBe(true);
  });

  test("hourly individual includes the hourly_rate", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "hourly",
      startDate: "2026-06-03",
      hourlyRate: "45",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        type: "Individual",
        first_name: "Sam",
        last_name: "Rivera",
        email: "s@x.com",
        wage_type: "Hourly",
        start_date: "2026-06-03",
        hourly_rate: "45",
        self_onboarding: false,
      },
    });
  });

  test("business with all required fields returns the populated body", () => {
    const result = validateContractorAdd({
      type: "business",
      businessName: "Acme LLC",
      email: "b@acme.com",
      wageType: "fixed",
      startDate: "2026-06-03",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        type: "Business",
        business_name: "Acme LLC",
        email: "b@acme.com",
        wage_type: "Fixed",
        start_date: "2026-06-03",
        self_onboarding: false,
      },
    });
  });

  test("missing --type blocks on type with the type-specific message", () => {
    const result = validateContractorAdd({ email: "s@x.com" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("missing or invalid --type");
    expect(result.blocked).toEqual([{ field: "type", reason: "must be 'individual' or 'business'" }]);
  });

  test("an unknown --type value is rejected", () => {
    const result = validateContractorAdd({ type: "freelancer" as never, email: "s@x.com" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "type" }));
  });

  test("missing wage-type and start-date block even when identity fields are present", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "wage-type" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
  });

  test("an invalid --wage-type value is rejected", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "salaried",
      startDate: "2026-06-03",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "wage-type" }));
  });

  test("a malformed --start-date is rejected", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "06/03/2026",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
  });

  test("a regex-valid but calendar-impossible --start-date is rejected", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "2026-02-30",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
  });

  test("hourly wage-type without --hourly-rate blocks on hourly-rate", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "hourly",
      startDate: "2026-06-03",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "hourly-rate" }));
  });

  test("a non-positive --hourly-rate is rejected", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "hourly",
      startDate: "2026-06-03",
      hourlyRate: "0",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "hourly-rate" }));
  });

  test("--hourly-rate passed with fixed wage-type is rejected, not silently dropped", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "2026-06-03",
      hourlyRate: "50",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "hourly-rate" }));
  });

  test("individual missing names blocks on names plus wage/start (email is admin-driven optional)", () => {
    const result = validateContractorAdd({ type: "individual" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("missing or invalid arguments");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "first-name" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "last-name" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "wage-type" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
    // Admin-driven is the default, so email is not required.
    expect(result.blocked).not.toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("admin-driven contractor without --email succeeds and omits email from the body", () => {
    const result = validateContractorAdd({
      type: "business",
      businessName: "Acme LLC",
      wageType: "fixed",
      startDate: "2026-06-03",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        type: "Business",
        business_name: "Acme LLC",
        wage_type: "Fixed",
        start_date: "2026-06-03",
        self_onboarding: false,
      },
    });
  });

  test("--self-onboarding requires --email", () => {
    const result = validateContractorAdd({
      type: "business",
      businessName: "Acme LLC",
      wageType: "fixed",
      startDate: "2026-06-03",
      selfOnboarding: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("hourly_rate is normalized to the validated value, not the raw input", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "hourly",
      startDate: "2026-06-03",
      hourlyRate: "1e3",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body).toEqual(expect.objectContaining({ wage_type: "Hourly", hourly_rate: "1000" }));
  });

  test("business does not require first/last name, only business-name + email + wage/start", () => {
    const result = validateContractorAdd({
      type: "business",
      email: "b@acme.com",
      wageType: "fixed",
      startDate: "2026-06-03",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toEqual([{ field: "business-name", reason: "required for business" }]);
  });
});

describe("runContractorAdd", () => {
  test("self-onboarding → POSTs the contractor, then PUTs the invite to onboarding_status", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/companies/co-1/contractors": [201, { uuid: "ctr-1", onboarding_status: "self_onboarding_not_invited" }],
      "PUT /v1/contractors/ctr-1/onboarding_status": [200, { onboarding_status: "self_onboarding_invited" }],
    });
    const result = await runContractorAdd(client, "co-1", SELF_ONBOARD_INDIVIDUAL);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(["contractor", "onboarding_status"]);

    // The create must precede the invite, and the invite targets the created contractor's uuid.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /v1/companies/co-1/contractors",
      "PUT /v1/contractors/ctr-1/onboarding_status",
    ]);
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ onboarding_status: "self_onboarding_invited" });
  });

  test("create succeeds but the invite fails → partial failure surfacing the created contractor", async () => {
    const { client } = stubApiClient({
      "POST /v1/companies/co-1/contractors": [201, { uuid: "ctr-1", onboarding_status: "self_onboarding_not_invited" }],
      "PUT /v1/contractors/ctr-1/onboarding_status": [422, { error: "cannot invite" }],
    });
    const result = await runContractorAdd(client, "co-1", SELF_ONBOARD_INDIVIDUAL);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("self_onboarding_invite_failed");
    const details = result.error.details as {
      contractor: { uuid: string };
      completed: string[];
      failed: { domain: string };
    };
    expect(details.completed).toEqual(["contractor"]);
    expect(details.failed.domain).toBe("onboarding_status");
    expect(details.contractor.uuid).toBe("ctr-1");
  });

  test("create returns no uuid → reports it without attempting the invite", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/companies/co-1/contractors": [201, { onboarding_status: "self_onboarding_not_invited" }],
    });
    const result = await runContractorAdd(client, "co-1", SELF_ONBOARD_INDIVIDUAL);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("contractor_created_without_uuid");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
    expect(calls.some((c) => c.url.includes("/onboarding_status"))).toBe(false);
  });

  test("create fails → surfaces the API error as-is and never attempts the invite", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/companies/co-1/contractors": [422, { error: "bad start_date" }],
    });
    const result = await runContractorAdd(client, "co-1", SELF_ONBOARD_INDIVIDUAL);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
    expect(calls.some((c) => c.url.includes("/onboarding_status"))).toBe(false);
  });
});

describe("contractorSelfOnboardSteps", () => {
  test("previews both the create POST and the invite PUT with placeholders", () => {
    expect(contractorSelfOnboardSteps(SELF_ONBOARD_INDIVIDUAL)).toEqual([
      { method: "POST", path: "/v1/companies/{company_uuid}/contractors", body: SELF_ONBOARD_INDIVIDUAL },
      {
        method: "PUT",
        path: "/v1/contractors/{contractor_uuid}/onboarding_status",
        body: { onboarding_status: "self_onboarding_invited" },
      },
    ]);
  });
});

let restoreList: () => void = () => {};
afterEach(() => restoreList());

describe("contractorListHandler pagination", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ uuid: `c${i}` }));

  test("default returns the first page and a next (via X-Total-Pages)", async () => {
    restoreList = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorListHandler({ ...TEST_AUTH })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(100);
    expect(result.next).toBeDefined();
  });

  test("--all concatenates every page with no next", async () => {
    restoreList = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorListHandler({ ...TEST_AUTH, all: true })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(250);
    expect(result.next).toBeUndefined();
  });

  test("--limit caps and emits no next", async () => {
    restoreList = stubGlobalFetch(pagedRouter(many(250), { withHeaders: true })).restore;
    const result = await contractorListHandler({ ...TEST_AUTH, limit: "40" })(TEST_CONTEXT);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data as unknown[]).toHaveLength(40);
    expect(result.next).toBeUndefined();
  });

  test("malformed --cursor fails validation (exit 7)", async () => {
    const result = await contractorListHandler({ ...TEST_AUTH, cursor: "garbage" })(TEST_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(7);
  });
});
