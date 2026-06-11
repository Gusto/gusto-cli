import { afterEach, describe, expect, test } from "bun:test";
import { companyFinishOnboardingHandler, companyOnboardingStatusHandler, companyShowHandler } from "./company.ts";
import type { CommandContext } from "../lib/runner.ts";
import {
  type MockResponse,
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  TEST_GLOBALS,
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
    // No blockers remain, so the navigation hook points at the finish verb rather
    // than dead-ending at next_command: null one step short of done (AINT-615).
    expect(d.next_command).toBe("gusto company finish");
    expect((d.suggested_action as { command: string }).command).toBe("gusto company finish");
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

  // The API never lists a signatory step; when sign_all_forms is pending the
  // handler GETs /signatories and synthesizes the blocker (AINT-618).
  const SIGN_FORMS_PENDING = {
    onboarding_completed: false,
    onboarding_steps: [{ id: "sign_all_forms", title: "Sign forms", required: true, completed: false }],
  };

  test("injects an assign_signatory blocker ahead of sign_all_forms when no signatory exists", async () => {
    routeFetch([
      { match: "/onboarding_status", status: 200, body: SIGN_FORMS_PENDING },
      { match: "/signatories", status: 200, body: [] }, // no signatory yet
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect((d.blocked_on as { id: string }[]).map((b) => b.id)).toEqual(["assign_signatory", "sign_all_forms"]);
    // sign_all_forms is gated: the signatory step is what surfaces as next.
    expect(d.next_command).toBe("gusto company setup signatory");
    expect(d.ready_to_finish).toBe(false);
  });

  test("does not inject when a signatory already exists; sign_all_forms is next", async () => {
    routeFetch([
      { match: "/onboarding_status", status: 200, body: SIGN_FORMS_PENDING },
      { match: "/signatories", status: 200, body: [{ uuid: "sig-1" }] },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect((d.blocked_on as { id: string }[]).map((b) => b.id)).toEqual(["sign_all_forms"]);
    expect(d.next_command).toBe("gusto company forms");
  });

  test("a failed signatories check records a partial error and does not fabricate a blocker", async () => {
    routeFetch([
      { match: "/onboarding_status", status: 200, body: SIGN_FORMS_PENDING },
      { match: "/signatories", status: 404, body: { error: "not found" } }, // 404 = not retried
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect((d.blocked_on as { id: string }[]).map((b) => b.id)).toEqual(["sign_all_forms"]);
    expect((d.partial_errors as { label: string }[]).map((e) => e.label)).toEqual(["signatories"]);
  });

  test("does not check signatories when sign_all_forms is not pending", async () => {
    // Only a /onboarding_status route is registered; a stray /signatories GET would 404
    // and surface as a partial error. Asserting none proves the call was skipped.
    routeFetch([
      {
        match: "/onboarding_status",
        status: 200,
        body: {
          onboarding_completed: false,
          onboarding_steps: [{ id: "federal_tax_setup", required: true, completed: false }],
        },
      },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect((d.blocked_on as { id: string }[]).map((b) => b.id)).toEqual(["federal_tax_setup"]);
    expect(d.partial_errors).toBeUndefined();
  });
});

describe("companyFinishOnboardingHandler", () => {
  const prodCtx: CommandContext = { command: "test", globals: { ...TEST_GLOBALS, env: "production" } };

  /** Stub fetch with a router and return both the result and the recorded calls so a
   * test can assert which PUTs were (or weren't) sent. */
  function stub(router: (u: string) => MockResponse) {
    const s = stubGlobalFetch(router);
    restore = s.restore;
    return s;
  }

  test("sandbox: finishes then auto-approves, reporting company_status Approved", async () => {
    const s = stub((u) => {
      if (u.includes("/finish_onboarding")) return { status: 200, body: { onboarding_completed: true } };
      if (u.includes("/approve")) return { status: 200, body: { company_status: "Approved" } };
      return { status: 404 };
    });
    const d = data(await companyFinishOnboardingHandler(auth)(ctx));
    expect(d.onboarding_completed).toBe(true);
    expect(d.approved).toBe(true);
    expect(d.company_status).toBe("Approved");
    const puts = s.calls.filter((c) => c.method === "PUT").map((c) => c.url);
    expect(puts.some((u) => u.includes("/finish_onboarding"))).toBe(true);
    expect(puts.some((u) => u.includes("/approve"))).toBe(true);
  });

  test("production: finishes only, never calls approve (the demo-only endpoint)", async () => {
    const s = stub((u) => {
      if (u.includes("/finish_onboarding")) return { status: 200, body: { onboarding_completed: true } };
      return { status: 404 };
    });
    const d = data(await companyFinishOnboardingHandler(auth)(prodCtx));
    expect(d.onboarding_completed).toBe(true);
    expect(d.approved).toBe(false);
    expect(s.calls.some((c) => c.url.includes("/approve"))).toBe(false);
  });

  test("--no-approve in sandbox finishes only and skips approve", async () => {
    const s = stub((u) => {
      if (u.includes("/finish_onboarding")) return { status: 200, body: { onboarding_completed: true } };
      return { status: 404 };
    });
    const d = data(await companyFinishOnboardingHandler({ ...auth, approve: false })(ctx));
    expect(d.onboarding_completed).toBe(true);
    expect(d.approved).toBe(false);
    expect(s.calls.some((c) => c.url.includes("/approve"))).toBe(false);
  });

  test("a finish_onboarding 422 surfaces the upstream body and never reaches approve", async () => {
    const s = stub((u) => {
      if (u.includes("/finish_onboarding"))
        return { status: 422, body: { errors: [{ category: "finish_onboarding_incomplete" }] } };
      return { status: 404 };
    });
    const result = await companyFinishOnboardingHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(s.calls.some((c) => c.url.includes("/approve"))).toBe(false);
    expect(result.error.details).toBeDefined();
  });

  test("finish succeeds but approve fails: partial error tells the agent to retry, not redo onboarding", async () => {
    stub((u) => {
      if (u.includes("/finish_onboarding")) return { status: 200, body: { onboarding_completed: true } };
      if (u.includes("/approve")) return { status: 422, body: { errors: [{ message: "cannot approve" }] } };
      return { status: 404 };
    });
    const result = await companyFinishOnboardingHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("approve_failed");
    expect((result.error.details as { onboarding_completed?: boolean }).onboarding_completed).toBe(true);
  });

  test("a malformed (empty 200) finish body degrades to null, not an internal_error throw", async () => {
    // A 200 with no body deserializes to null. Reading onboarding_completed off it
    // must not throw past the handler (which would surface as exit-1 internal_error).
    stub((u) => {
      if (u.includes("/finish_onboarding")) return { status: 200 }; // empty body -> null
      if (u.includes("/approve")) return { status: 200, body: { company_status: "Approved" } };
      return { status: 404 };
    });
    const d = data(await companyFinishOnboardingHandler(auth)(ctx));
    expect(d.onboarding_completed).toBeNull();
    expect(d.approved).toBe(true);
  });

  test("dry-run lists both PUTs in sandbox and sends nothing", async () => {
    const s = stub(() => ({ status: 500 })); // any real call would fail the test
    const d = data(await companyFinishOnboardingHandler({ ...auth, dryRun: true })(ctx));
    expect(d.will_approve).toBe(true);
    expect((d.steps as { path: string }[]).map((step) => step.path)).toEqual([
      "/v1/companies/{company_uuid}/finish_onboarding",
      "/v1/companies/{company_uuid}/approve",
    ]);
    expect(s.calls).toHaveLength(0);
  });

  test("dry-run in production omits the approve step", async () => {
    stub(() => ({ status: 500 }));
    const d = data(await companyFinishOnboardingHandler({ ...auth, dryRun: true })(prodCtx));
    expect(d.will_approve).toBe(false);
    expect((d.steps as { path: string }[]).map((step) => step.path)).toEqual([
      "/v1/companies/{company_uuid}/finish_onboarding",
    ]);
  });
});
