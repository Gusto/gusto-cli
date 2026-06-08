import { afterEach, describe, expect, test } from "bun:test";
import { companyOnboardingStatusHandler, companyShowHandler } from "./company.ts";
import {
  type MockResponse,
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  okData as data,
  stubGlobalFetch,
} from "../lib/test-support.ts";

interface Route extends MockResponse {
  match: string;
}

let restore: () => void = () => {};
afterEach(() => restore());

/** Stub global fetch, routing each request to the first route whose substring the URL contains. */
function routeFetch(routes: Route[]): void {
  restore = stubGlobalFetch((u) => routes.find((rt) => u.includes(rt.match)) ?? { status: 404 }).restore;
}

describe("companyShowHandler", () => {
  test("aggregates the three GETs and surfaces a partial 404 without failing", async () => {
    // Order matters: more specific suffixes before the bare /companies/co-1.
    routeFetch([
      { match: "/payment_configs", status: 404 },
      {
        match: "/pay_schedules",
        status: 200,
        body: [{ frequency: "Every other week", anchor_pay_date: "2026-02-13" }],
      },
      { match: "/companies/co-1", status: 200, body: { name: "Acme", company_status: "Approved", ein: "12-3456789" } },
    ]);

    const d = data(await companyShowHandler(auth)(ctx));
    expect(d.success).toBe(false);
    expect((d.summary as Record<string, unknown>).name).toBe("Acme");
    expect((d.summary as Record<string, unknown>).status).toBe("Approved");
    expect((d.summary as { pay_schedule?: { frequency?: string } }).pay_schedule?.frequency).toBe("Every other week");
    const partial = d.partial_errors as { label: string }[];
    expect(partial.map((e) => e.label)).toEqual(["payment_config"]);
  });

  test("a failed primary company GET nulls the summary and reports partial_errors", async () => {
    routeFetch([
      { match: "/payment_configs", status: 200, body: { payment_speed: "standard" } },
      { match: "/pay_schedules", status: 200, body: [] },
      { match: "/companies/co-1", status: 404, body: { error: "not found" } }, // primary company GET fails (404 = not retried)
    ]);
    const d = data(await companyShowHandler(auth)(ctx));
    expect(d.success).toBe(false);
    expect((d.summary as { name: string | null }).name).toBeNull();
    expect((d.partial_errors as { label: string }[]).map((e) => e.label)).toContain("company");
  });

  test("all three GETs succeed: success true, no partial_errors", async () => {
    routeFetch([
      { match: "/payment_configs", status: 200, body: { payment_speed: "standard" } },
      { match: "/pay_schedules", status: 200, body: [{ frequency: "Every week", anchor_pay_date: "2026-02-06" }] },
      { match: "/companies/co-1", status: 200, body: { name: "Acme", company_status: "Approved" } },
    ]);
    const d = data(await companyShowHandler(auth)(ctx));
    expect(d.success).toBe(true);
    expect(d.partial_errors).toBeUndefined();
    expect((d.summary as { payment_speed?: string }).payment_speed).toBe("standard");
  });
});

describe("companyOnboardingStatusHandler", () => {
  test("computes stage + blocked_on + next_command from onboarding_steps", async () => {
    routeFetch([
      {
        match: "/onboarding_status",
        status: 200,
        body: {
          onboarding_completed: false,
          onboarding_steps: [
            { id: "federal_tax_setup", title: "Federal", required: true, completed: false },
            { id: "add_bank_info", title: "Bank", required: true, completed: true },
          ],
        },
      },
    ]);

    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("onboarding");
    expect((d.blocked_on as { id: string }[]).map((b) => b.id)).toEqual(["federal_tax_setup"]);
    expect(d.next_command).toBe("gusto company setup federal-tax");
    expect(d.ready_to_finish).toBe(false);
  });

  test("ready_to_finish when blockers are clear but onboarding isn't marked complete", async () => {
    routeFetch([
      {
        match: "/onboarding_status",
        status: 200,
        body: {
          onboarding_completed: false,
          onboarding_steps: [{ id: "federal_tax_setup", required: true, completed: true }],
        },
      },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("ready_to_finish");
    expect(d.ready_to_finish).toBe(true);
    expect(d.blocked_on).toEqual([]);
  });

  test("a malformed 200 (no onboarding_steps) is stage 'unknown', not ready_to_finish", async () => {
    routeFetch([{ match: "/onboarding_status", status: 200, body: { onboarding_completed: false } }]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("unknown");
    expect(d.ready_to_finish).toBe(false);
    expect(d.blocked_on).toEqual([]);
  });

  test("onboarding_completed yields stage done with no blockers", async () => {
    routeFetch([
      { match: "/onboarding_status", status: 200, body: { onboarding_completed: true, onboarding_steps: [] } },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("done");
    expect(d.blocked_on).toEqual([]);
    expect(d.next_command).toBeNull();
  });
});
