import { afterEach, describe, expect, test } from "bun:test";
import { pagedRouter, stubApiClient, stubGlobalFetch, TEST_AUTH, TEST_CONTEXT } from "../lib/test-support.ts";
import { contractorListHandler, runContractorAdd, validateContractorAdd } from "./contractor.ts";

let restoreList: () => void = () => {};
afterEach(() => restoreList());

const VALID_INDIVIDUAL = {
  type: "individual" as const,
  firstName: "Sam",
  lastName: "Rivera",
  email: "sam@example.com",
  wageType: "fixed",
  startDate: "2026-07-01",
};

describe("validateContractorAdd (self-onboarding only)", () => {
  test("a valid individual produces a self-onboarding body carrying the invite email", () => {
    const result = validateContractorAdd(VALID_INDIVIDUAL);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.body.self_onboarding).toBe(true);
    expect(result.body.email).toBe("sam@example.com");
    expect(result.body.type).toBe("Individual");
  });

  test("a valid business produces a self-onboarding body carrying the invite email", () => {
    const result = validateContractorAdd({
      type: "business",
      businessName: "Acme LLC",
      email: "billing@acme.example.com",
      wageType: "fixed",
      startDate: "2026-07-01",
    });
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.body.self_onboarding).toBe(true);
    expect(result.body.email).toBe("billing@acme.example.com");
    expect(result.body.type).toBe("Business");
  });

  test("email is required - it's where the self-onboarding invite is sent", () => {
    const result = validateContractorAdd({ ...VALID_INDIVIDUAL, email: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.map((b) => b.field)).toContain("email");
  });

  test("still validates the non-sensitive required fields (wage-type)", () => {
    const result = validateContractorAdd({ ...VALID_INDIVIDUAL, wageType: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.map((b) => b.field)).toContain("wage-type");
  });
});

describe("runContractorAdd", () => {
  test("creates the contractor then sends the self-onboarding invite (POST + PUT)", async () => {
    const { client, calls } = stubApiClient({
      "POST /v1/companies/co-1/contractors": [201, { uuid: "ctr-1" }],
      "PUT /v1/contractors/ctr-1/onboarding_status": [200, { onboarding_status: "self_onboarding_invited" }],
    });
    const validation = validateContractorAdd(VALID_INDIVIDUAL);
    if (!validation.ok) throw new Error("fixture should validate");
    const result = await runContractorAdd(client, "co-1", validation.body);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect((calls[0]?.body as { self_onboarding: boolean }).self_onboarding).toBe(true);
    expect(calls[1]).toMatchObject({ method: "PUT" });
    expect((calls[1]?.body as { onboarding_status: string }).onboarding_status).toBe("self_onboarding_invited");
  });

  test("a created contractor whose invite fails surfaces a partial failure with the uuid", async () => {
    const { client } = stubApiClient({
      "POST /v1/companies/co-1/contractors": [201, { uuid: "ctr-1" }],
      "PUT /v1/contractors/ctr-1/onboarding_status": [500, { error: "boom" }],
    });
    const validation = validateContractorAdd(VALID_INDIVIDUAL);
    if (!validation.ok) throw new Error("fixture should validate");
    const result = await runContractorAdd(client, "co-1", validation.body);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).toContain("ctr-1");
  });
});

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
