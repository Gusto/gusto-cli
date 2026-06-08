import { afterEach, describe, expect, test } from "bun:test";
import type { GlobalFlags } from "../lib/global-flags.ts";
import type { CommandResult } from "../lib/runner.ts";
import { bankAccountHandler, federalTaxHandler, stateTaxHandler } from "./company-setup.ts";

const globals: GlobalFlags = { agent: true, human: false, json: false, verbose: false, env: "sandbox" };
const ctx = { command: "test", globals };
const auth = { token: "tkn", companyUuid: "co-1" };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

interface MockResponse {
  status: number;
  body?: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub global fetch with one response per call (last repeats), recording each call. */
function stubFetch(responses: MockResponse[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const idx = Math.min(calls.length, responses.length - 1);
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      method: init?.method ?? "GET",
      url: url.toString(),
      body: bodyStr ? JSON.parse(bodyStr) : undefined,
    });
    const r = responses[idx] ?? { status: 200 };
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : "", {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

function data(result: CommandResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown>;
}

describe("federalTaxHandler (network)", () => {
  test("reads current version, then PUTs federal_tax_details with it", async () => {
    const calls = stubFetch([
      { status: 200, body: { version: "v1" } },
      { status: 200, body: { uuid: "ft-1", version: "v2" } },
    ]);

    const d = data(
      await federalTaxHandler({
        ...auth,
        ein: "12-3456789",
        taxPayerType: "S-Corporation",
        filingForm: "941",
        legalName: "Acme Inc.",
      })(ctx),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PUT");
    expect(calls[1]?.body).toMatchObject({
      version: "v1",
      ein: "12-3456789",
      tax_payer_type: "S-Corporation",
      taxable_as_scorp: true,
    });
    expect(d.ein_used).toBe("12-3456789");
    expect(d.ein_auto_rotated).toBeUndefined();
  });

  test("auto-rotates the EIN on a 422 'already in use' and retries once", async () => {
    const calls = stubFetch([
      { status: 200, body: { version: "v1" } },
      { status: 422, body: { error: "EIN is already in use by another company" } },
      { status: 200, body: { version: "v2" } },
      { status: 200, body: { uuid: "ft-1" } },
    ]);

    const d = data(
      await federalTaxHandler({
        ...auth,
        ein: "12-3456789",
        taxPayerType: "LLC",
        filingForm: "941",
        legalName: "Acme Inc.",
      })(ctx),
    );

    expect(calls).toHaveLength(4);
    expect(d.ein_auto_rotated).toBe(true);
    expect(d.ein_provided).toBe("12-3456789");
    expect(d.ein_used).not.toBe("12-3456789");
    // First PUT used the provided EIN + v1; the retried PUT used the rotated EIN + v2.
    expect((calls[1]?.body as { ein: string }).ein).toBe("12-3456789");
    expect((calls[1]?.body as { version: string }).version).toBe("v1");
    expect((calls[3]?.body as { ein: string }).ein).toBe(d.ein_used as string);
    expect((calls[3]?.body as { version: string }).version).toBe("v2");
  });

  test("a non-EIN 422 is not retried and surfaces as an error", async () => {
    const calls = stubFetch([
      { status: 200, body: { version: "v1" } },
      { status: 422, body: { error: "filing_form is invalid" } },
    ]);

    const result = await federalTaxHandler({
      ...auth,
      ein: "12-3456789",
      taxPayerType: "LLC",
      filingForm: "999",
      legalName: "Acme Inc.",
    })(ctx);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe("bankAccountHandler (network)", () => {
  test("runs create -> send_test_deposits -> verify in sequence", async () => {
    const calls = stubFetch([
      { status: 201, body: { uuid: "bank-1" } },
      { status: 200, body: { deposit_1: "0.02", deposit_2: "0.03" } },
      { status: 200, body: { verified: true } },
    ]);

    const d = data(
      await bankAccountHandler({ ...auth, routing: "123456789", accountNumber: "987654321", accountType: "Checking" })(
        ctx,
      ),
    );

    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "PUT"]);
    expect(calls[0]?.url).toContain("/bank_accounts");
    expect(calls[1]?.url).toContain("/bank_accounts/bank-1/send_test_deposits");
    expect(calls[2]?.url).toContain("/bank_accounts/bank-1/verify");
    expect(calls[2]?.body).toEqual({ deposit_1: 0.02, deposit_2: 0.03 });
    expect(d).toMatchObject({ bank_account_uuid: "bank-1", verification_status: "verified" });
  });
});

describe("stateTaxHandler (network)", () => {
  test("blocks when no employee work addresses are found", async () => {
    // employees: [], locations: []
    stubFetch([
      { status: 200, body: [] },
      { status: 200, body: [] },
    ]);
    const result = await stateTaxHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("no_work_addresses");
  });

  test("opts a CA employee into the new-employer default rate", async () => {
    const calls = stubFetch([
      { status: 200, body: [{ uuid: "emp-1", jobs: [{}] }] }, // employees
      { status: 200, body: [{ uuid: "loc-1" }] }, // locations
      { status: 200, body: [{ active: true, state: "CA" }] }, // emp-1 work_addresses
      {
        status: 200,
        body: {
          requirement_sets: [
            {
              key: "taxrates",
              effective_from: "2026-01-01",
              requirements: [{ key: "usedefaultsuirates", editable: true, applicable_if: [] }],
            },
          ],
        },
      }, // GET tax_requirements/CA
      { status: 200, body: {} }, // PUT tax_requirements/CA
      { status: 200, body: [{ state: "CA", ready_to_run_payroll: true }] }, // GET tax_requirements
    ]);

    const d = data(await stateTaxHandler(auth)(ctx));
    expect(d.states_found).toEqual(["CA"]);
    expect(d.ready).toBe(true);
    const putCall = calls.find((c) => c.method === "PUT" && c.url.includes("/tax_requirements/CA"));
    expect(putCall?.body).toMatchObject({
      requirement_sets: [{ key: "taxrates", requirements: [{ key: "usedefaultsuirates", value: true }] }],
    });
  });
});
