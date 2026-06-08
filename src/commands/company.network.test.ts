import { afterEach, describe, expect, test } from "bun:test";
import type { GlobalFlags } from "../lib/global-flags.ts";
import type { CommandResult } from "../lib/runner.ts";
import { companyOnboardingStatusHandler, companyShowHandler } from "./company.ts";
import { type MockResponse, stubGlobalFetch } from "../lib/test-support.ts";

const globals: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };
const ctx = { command: "test", globals };
const auth = { token: "tkn", companyUuid: "co-1" };

interface Route extends MockResponse {
  match: string;
}

let restore: () => void = () => {};
afterEach(() => restore());

/** Stub global fetch, routing each request to the first route whose substring the URL contains. */
function routeFetch(routes: Route[]): void {
  restore = stubGlobalFetch((u) => routes.find((rt) => u.includes(rt.match)) ?? { status: 404 }).restore;
}

function data(result: CommandResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown>;
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
