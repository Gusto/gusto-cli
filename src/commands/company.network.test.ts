import { afterEach, describe, expect, test } from "bun:test";
import { companyLocationsHandler, companyShowHandler } from "./company.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import {
  type Route,
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  okData as data,
  routeFetch as setupRouteFetch,
} from "../lib/test-support.ts";

let restore: () => void = () => {};
afterEach(() => restore());

/** Wraps the shared `routeFetch` to assign the file-level `restore` for the local `afterEach`. */
function routeFetch(routes: Route[]): void {
  restore = setupRouteFetch(routes).restore;
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

  test("a failed primary company GET is a real failure, not a buried partial_error", async () => {
    routeFetch([
      { match: "/payment_configs", status: 200, body: { payment_speed: "standard" } },
      { match: "/pay_schedules", status: 200, body: [] },
      { match: "/companies/co-1", status: 404, body: { error: "not found" } }, // primary company GET fails (404 = not retried)
    ]);
    const result = await companyShowHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
    expect(result.error.details).toMatchObject({ error: "not found" });
  });

  test("company succeeds but a secondary pay_schedules GET fails: ok:true with partial_errors", async () => {
    routeFetch([
      { match: "/payment_configs", status: 200, body: { payment_speed: "standard" } },
      { match: "/pay_schedules", status: 404, body: { error: "not found" } }, // 404 = not retried
      { match: "/companies/co-1", status: 200, body: { name: "Acme", company_status: "Approved" } },
    ]);
    const result = await companyShowHandler(auth)(ctx);
    expect(result.ok).toBe(true);
    const d = data(result);
    expect(d.success).toBe(false);
    expect((d.summary as { name: string | null }).name).toBe("Acme");
    expect((d.partial_errors as { label: string }[]).map((e) => e.label)).toEqual(["pay_schedules"]);
  });

  test("payment_config 404 is suppressed when the company isn't partner-managed", async () => {
    routeFetch([
      { match: "/payment_configs", status: 404, body: { errors: [{ category: "not_found" }] } },
      { match: "/pay_schedules", status: 200, body: [{ frequency: "Every week", anchor_pay_date: "2026-02-06" }] },
      {
        match: "/companies/co-1",
        status: 200,
        body: { name: "Acme", company_status: "Approved", is_partner_managed: false },
      },
    ]);
    const d = data(await companyShowHandler(auth)(ctx));
    expect(d.success).toBe(true);
    expect(d.partial_errors).toBeUndefined();
    expect(d.payment_config).toBeNull();
  });

  test("non-404 payment_config failure still surfaces on a non-partner-managed company", async () => {
    // Suppression must be narrow: only the expected 404. A 401/422/etc on the same endpoint
    // is a real failure the user should still see.
    routeFetch([
      { match: "/payment_configs", status: 422, body: { errors: [{ category: "invalid_request" }] } },
      { match: "/pay_schedules", status: 200, body: [] },
      {
        match: "/companies/co-1",
        status: 200,
        body: { name: "Acme", company_status: "Approved", is_partner_managed: false },
      },
    ]);
    const d = data(await companyShowHandler(auth)(ctx));
    expect(d.success).toBe(false);
    expect((d.partial_errors as { label: string }[]).map((e) => e.label)).toContain("payment_config");
  });

  test("payment_config 404 still surfaces when the company IS partner-managed (real bug)", async () => {
    routeFetch([
      { match: "/payment_configs", status: 404, body: { errors: [{ category: "not_found" }] } },
      { match: "/pay_schedules", status: 200, body: [] },
      {
        match: "/companies/co-1",
        status: 200,
        body: { name: "Acme", company_status: "Approved", is_partner_managed: true },
      },
    ]);
    const d = data(await companyShowHandler(auth)(ctx));
    expect(d.success).toBe(false);
    expect((d.partial_errors as { label: string }[]).map((e) => e.label)).toContain("payment_config");
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

describe("companyLocationsHandler", () => {
  test("wraps the API list under a `locations` key (the field-filter target)", async () => {
    routeFetch([
      {
        match: "/locations",
        status: 200,
        body: [
          { uuid: "loc-1", street_1: "300 3rd St", city: "San Francisco", state: "CA", zip: "94107", primary: true },
          { uuid: "loc-2", street_1: "1 Market St", city: "San Francisco", state: "CA", zip: "94105" },
        ],
      },
    ]);
    const d = data(await companyLocationsHandler(auth)(ctx));
    const locations = d.locations as { uuid: string; primary?: boolean }[];
    expect(locations).toHaveLength(2);
    expect(locations[0]?.uuid).toBe("loc-1");
    expect(locations[0]?.primary).toBe(true);
  });

  test("returns an empty list for a company with no locations", async () => {
    routeFetch([{ match: "/locations", status: 200, body: [] }]);
    const d = data(await companyLocationsHandler(auth)(ctx));
    expect(d.locations).toEqual([]);
  });

  test("surfaces an API error as a failed CommandResult (not silently wrapped)", async () => {
    routeFetch([{ match: "/locations", status: 404, body: { error: "not found" } }]);
    const result = await companyLocationsHandler(auth)(ctx);
    expect(result.ok).toBe(false);
  });
});
