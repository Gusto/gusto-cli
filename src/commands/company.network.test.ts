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
      { match: "/payrolls/blockers", status: 200, body: [{ key: "needs_onboarding", message: "Finish onboarding." }] },
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
    // Onboarding still incomplete -> not payroll-ready; needs_onboarding is dropped from
    // the payroll section because this command already drives the onboarding flow.
    expect(d.payroll_ready).toBe(false);
    expect(d.payroll_blockers).toEqual([]);
  });

  test("ready_to_finish when blockers are clear but onboarding isn't marked complete", async () => {
    routeFetch([
      { match: "/payrolls/blockers", status: 200, body: [{ key: "needs_onboarding", message: "Finish onboarding." }] },
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
    routeFetch([
      { match: "/payrolls/blockers", status: 200, body: [] },
      { match: "/onboarding_status", status: 200, body: { onboarding_completed: false } },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("unknown");
    expect(d.ready_to_finish).toBe(false);
    expect(d.blocked_on).toEqual([]);
  });

  test("onboarding_completed AND no payroll blockers yields stage done", async () => {
    routeFetch([
      { match: "/payrolls/blockers", status: 200, body: [] },
      { match: "/onboarding_status", status: 200, body: { onboarding_completed: true, onboarding_steps: [] } },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("done");
    expect(d.blocked_on).toEqual([]);
    expect(d.payroll_ready).toBe(true);
    expect(d.payroll_blockers).toEqual([]);
    expect(d.next_command).toBeNull();
  });

  test("onboarding_completed but payroll blockers remain -> not_payroll_ready, not done", async () => {
    // The AINT-643 bug: finish_onboarding flips onboarding_completed but the company
    // still can't run payroll. The payroll blockers surface as their own section, each
    // mapped to a resolving command (null for wait-states like needs_approval), and
    // next_command drives the first actionable one.
    routeFetch([
      {
        match: "/payrolls/blockers",
        status: 200,
        body: [
          { key: "missing_employee_setup", message: "Team members need personal details." },
          { key: "needs_approval", message: "Company needs to be approved to run payroll." },
        ],
      },
      { match: "/onboarding_status", status: 200, body: { onboarding_completed: true, onboarding_steps: [] } },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("not_payroll_ready");
    expect(d.payroll_ready).toBe(false);
    expect((d.payroll_blockers as { key: string }[]).map((b) => b.key)).toEqual([
      "missing_employee_setup",
      "needs_approval",
    ]);
    expect(d.next_command).toBe("gusto employee add personal-details");
    expect((d.suggested_action as { command: string }).command).toBe("gusto employee add personal-details");
  });

  test("a keyed blocker with no message still blocks payroll (no false-ready)", async () => {
    // The sole blocker is identifiable (has a key) but the API omitted message. It must
    // keep the company not-payroll-ready - dropping it would shrink the list to empty and
    // report payroll_ready: true, the failure AINT-643 exists to prevent.
    routeFetch([
      { match: "/payrolls/blockers", status: 200, body: [{ key: "missing_employee_setup" }] },
      { match: "/onboarding_status", status: 200, body: { onboarding_completed: true, onboarding_steps: [] } },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("not_payroll_ready");
    expect(d.payroll_ready).toBe(false);
    expect(d.payroll_blockers).toEqual([
      {
        key: "missing_employee_setup",
        message: "",
        suggested_action: {
          command: "gusto employee add personal-details",
          required_flags: ["--first-name", "--last-name", "--email"],
          optional_flags: ["--admin-driven", "--ssn", "--date-of-birth", "--company-uuid"],
          source: "cli_static_map",
        },
      },
    ]);
    expect(d.next_command).toBe("gusto employee add personal-details");
  });

  test("not_payroll_ready with only wait-state blockers yields next_command null", async () => {
    routeFetch([
      {
        match: "/payrolls/blockers",
        status: 200,
        body: [{ key: "needs_approval", message: "Company needs to be approved to run payroll." }],
      },
      { match: "/onboarding_status", status: 200, body: { onboarding_completed: true, onboarding_steps: [] } },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect(d.stage).toBe("not_payroll_ready");
    expect((d.payroll_blockers as { key: string }[]).map((b) => b.key)).toEqual(["needs_approval"]);
    // No CLI command resolves an approval wait - the agent reports it and waits.
    expect(d.next_command).toBeNull();
  });

  test("payroll blockers are deduped against open onboarding blockers", async () => {
    // missing_federal_tax_setup mirrors the still-open federal_tax_setup onboarding step,
    // so it's dropped from the payroll section; missing_employee_setup is the genuinely
    // additional gate and stays. Onboarding drives next_command while it's incomplete.
    routeFetch([
      {
        match: "/payrolls/blockers",
        status: 200,
        body: [
          { key: "missing_federal_tax_setup", message: "Set up federal tax." },
          { key: "missing_employee_setup", message: "Team members need personal details." },
        ],
      },
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
    expect(d.stage).toBe("onboarding");
    expect(d.next_command).toBe("gusto company setup federal-tax");
    expect((d.payroll_blockers as { key: string }[]).map((b) => b.key)).toEqual(["missing_employee_setup"]);
  });

  test("a failed payroll-blockers fetch records a partial error and leaves readiness unknown", async () => {
    routeFetch([
      { match: "/payrolls/blockers", status: 404, body: { error: "not found" } }, // 404 = not retried
      { match: "/onboarding_status", status: 200, body: { onboarding_completed: true, onboarding_steps: [] } },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    // Readiness unknown must not fabricate not_payroll_ready - onboarding-based stage stands.
    expect(d.stage).toBe("done");
    expect(d.payroll_ready).toBeNull();
    expect(d.payroll_blockers).toEqual([]);
    expect((d.partial_errors as { label: string }[]).map((e) => e.label)).toEqual(["payroll_blockers"]);
  });

  // The API never lists a signatory step; when sign_all_forms is pending the
  // handler GETs /signatories and synthesizes the blocker (AINT-618).
  const SIGN_FORMS_PENDING = {
    onboarding_completed: false,
    onboarding_steps: [{ id: "sign_all_forms", title: "Sign forms", required: true, completed: false }],
  };

  test("injects an assign_signatory blocker ahead of sign_all_forms when no signatory exists", async () => {
    routeFetch([
      { match: "/payrolls/blockers", status: 200, body: [] },
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
      { match: "/payrolls/blockers", status: 200, body: [] },
      { match: "/onboarding_status", status: 200, body: SIGN_FORMS_PENDING },
      { match: "/signatories", status: 200, body: [{ uuid: "sig-1" }] },
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect((d.blocked_on as { id: string }[]).map((b) => b.id)).toEqual(["sign_all_forms"]);
    expect(d.next_command).toBe("gusto company forms");
  });

  test("a failed signatories check records a partial error and does not fabricate a blocker", async () => {
    routeFetch([
      { match: "/payrolls/blockers", status: 200, body: [] },
      { match: "/onboarding_status", status: 200, body: SIGN_FORMS_PENDING },
      { match: "/signatories", status: 404, body: { error: "not found" } }, // 404 = not retried
    ]);
    const d = data(await companyOnboardingStatusHandler(auth)(ctx));
    expect((d.blocked_on as { id: string }[]).map((b) => b.id)).toEqual(["sign_all_forms"]);
    expect((d.partial_errors as { label: string }[]).map((e) => e.label)).toEqual(["signatories"]);
  });

  test("does not check signatories when sign_all_forms is not pending", async () => {
    // Only /onboarding_status and /payrolls/blockers routes are registered; a stray
    // /signatories GET would 404 and surface as a partial error. Asserting none proves
    // the signatory call was skipped.
    routeFetch([
      { match: "/payrolls/blockers", status: 200, body: [] },
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
  const prodCtx: CommandContext = { ...ctx, globals: { ...TEST_GLOBALS, env: "production" } };

  /** Stub fetch with a router and return both the result and the recorded calls so a
   * test can assert which PUTs were (or weren't) sent. */
  function stub(router: (u: string) => MockResponse) {
    const s = stubGlobalFetch(router);
    restore = s.restore;
    return s;
  }

  test("finishes onboarding via finish_onboarding only - the approve endpoint is gone", async () => {
    const s = stub((u) => {
      if (u.includes("/finish_onboarding")) return { status: 200, body: { onboarding_completed: true } };
      return { status: 404 };
    });
    const d = data(await companyFinishOnboardingHandler(auth)(ctx));
    expect(d.onboarding_completed).toBe(true);
    expect(d.message).toContain("onboarding_completed -> true");
    const puts = s.calls.filter((c) => c.method === "PUT").map((c) => c.url);
    expect(puts.some((u) => u.includes("/finish_onboarding"))).toBe(true);
    // approve was dropped (re-add when payroll-running lands) - it must never be called.
    expect(s.calls.some((c) => c.url.includes("/approve"))).toBe(false);
  });

  test("a 200 that hasn't flipped the flag reports accepted-but-unconfirmed, not a false success", async () => {
    stub((u) =>
      u.includes("/finish_onboarding") ? { status: 200, body: { onboarding_completed: false } } : { status: 404 },
    );
    const d = data(await companyFinishOnboardingHandler(auth)(ctx));
    expect(d.onboarding_completed).toBe(false);
    // The message must not claim completion when the API didn't confirm it.
    expect(d.message).not.toContain("-> true");
    expect(d.message).toMatch(/onboarding-status/);
  });

  test("behaves identically in production - finish only, still no approve call", async () => {
    const s = stub((u) => {
      if (u.includes("/finish_onboarding")) return { status: 200, body: { onboarding_completed: true } };
      return { status: 404 };
    });
    const d = data(await companyFinishOnboardingHandler(auth)(prodCtx));
    expect(d.onboarding_completed).toBe(true);
    expect(s.calls.some((c) => c.url.includes("/approve"))).toBe(false);
  });

  test("a finish_onboarding 422 surfaces the upstream body", async () => {
    stub((u) => {
      if (u.includes("/finish_onboarding"))
        return { status: 422, body: { errors: [{ category: "finish_onboarding_incomplete" }] } };
      return { status: 404 };
    });
    const result = await companyFinishOnboardingHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // Assert the upstream category actually survives into details - not just that
    // *something* is there. A regression that swallowed the body to a generic
    // message would still pass a bare toBeDefined, but must fail this.
    expect(result.error.details).toMatchObject({ errors: [{ category: "finish_onboarding_incomplete" }] });
  });

  test("a malformed (empty 200) finish body degrades to null, not an internal_error throw", async () => {
    // A 200 with no body deserializes to null. Reading onboarding_completed off it
    // must not throw past the handler (which would surface as exit-1 internal_error).
    stub((u) => {
      if (u.includes("/finish_onboarding")) return { status: 200 }; // empty body -> null
      return { status: 404 };
    });
    const d = data(await companyFinishOnboardingHandler(auth)(ctx));
    expect(d.onboarding_completed).toBeNull();
    // A null flag is unconfirmed, so the message must not claim completion either.
    expect(d.message).not.toContain("-> true");
  });

  test("dry-run lists only finish_onboarding and sends nothing", async () => {
    const s = stub(() => ({ status: 500 })); // any real call would fail the test
    const d = data(await companyFinishOnboardingHandler({ ...auth, dryRun: true })(ctx));
    expect((d.steps as { path: string }[]).map((step) => step.path)).toEqual([
      "/v1/companies/{company_uuid}/finish_onboarding",
    ]);
    expect(s.calls).toHaveLength(0);
  });
});
