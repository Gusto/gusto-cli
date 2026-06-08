import { afterEach, describe, expect, test } from "bun:test";
import type { GlobalFlags } from "../lib/global-flags.ts";
import { bankAccountHandler, federalTaxHandler, formsHandler, stateTaxHandler } from "./company-setup.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import {
  type MockResponse,
  type RecordedCall,
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  TEST_GLOBALS as globals,
  okData as data,
  stubGlobalFetch,
} from "../lib/test-support.ts";

let restore: () => void = () => {};
afterEach(() => restore());

/** Stub global fetch with one response per call (last repeats), recording each call. */
function stubFetch(responses: MockResponse[]): RecordedCall[] {
  const s = stubGlobalFetch(responses);
  restore = s.restore;
  return s.calls;
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

  test("does NOT auto-rotate the EIN on production - surfaces the 422 instead", async () => {
    const calls = stubFetch([
      { status: 200, body: { version: "v1" } },
      { status: 422, body: { errors: [{ message: "EIN is already in use" }] } },
    ]);
    const prod: GlobalFlags = { ...globals, env: "production" };
    const result = await federalTaxHandler({
      ...auth,
      ein: "12-3456789",
      taxPayerType: "LLC",
      filingForm: "941",
      legalName: "Acme Inc.",
    })({ command: "test", globals: prod });

    expect(result.ok).toBe(false);
    // GET + one PUT only - no fabricated-EIN retry.
    expect(calls).toHaveLength(2);
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

  test("surfaces bank_account_uuid + phase when verify fails after create", async () => {
    stubFetch([
      { status: 201, body: { uuid: "bank-1" } }, // create
      { status: 200, body: { deposit_1: "0.02", deposit_2: "0.03" } }, // send_test_deposits
      { status: 422, body: { errors: [{ message: "amounts do not match" }] } }, // verify
    ]);
    const result = await bankAccountHandler({
      ...auth,
      routing: "123456789",
      accountNumber: "987654321",
      accountType: "Checking",
    })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("bank_verification_failed");
    expect(result.error.details).toMatchObject({ bank_account_uuid: "bank-1", phase: "verify" });
  });

  test("flags a malformed send_test_deposits response instead of PUTting null", async () => {
    const calls = stubFetch([
      { status: 201, body: { uuid: "bank-1" } },
      // deposit_1 is null with a valid deposit_2: Number(null) is 0 (finite), so the
      // guard must reject null explicitly rather than rely on isFinite alone.
      { status: 200, body: { deposit_1: null, deposit_2: "0.03" } },
    ]);
    const result = await bankAccountHandler({
      ...auth,
      routing: "123456789",
      accountNumber: "987654321",
      accountType: "Checking",
    })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("bank_verification_failed");
    // Error is attributed to the send_test_deposits phase, not verify.
    expect(result.error.details).toMatchObject({ phase: "send_test_deposits" });
    // No verify PUT should have been attempted with bad amounts.
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
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

  test("auto-provisions a missing work address from the primary location", async () => {
    const calls = stubFetch([
      { status: 200, body: [{ uuid: "emp-1", jobs: [{}] }] }, // employees (has a job)
      { status: 200, body: [{ uuid: "loc-1" }] }, // locations
      { status: 200, body: [] }, // emp-1 work_addresses: none yet
      { status: 201, body: {} }, // POST work_addresses
      { status: 200, body: [{ active: true, state: "CA" }] }, // reload work_addresses
      { status: 200, body: { requirement_sets: [] } }, // GET tax_requirements/CA (no default rate)
      { status: 200, body: [{ state: "CA", ready_to_run_payroll: false }] }, // GET tax_requirements
    ]);
    const d = data(await stateTaxHandler(auth)(ctx));
    expect(d.states_found).toEqual(["CA"]);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/employees/emp-1/work_addresses"));
    expect(post?.body).toMatchObject({ location_uuid: "loc-1", active: true });
  });

  test("reports a per-state submit failure without aborting the run", async () => {
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1" }] }, // employees (no job -> no provisioning)
      { status: 200, body: [] }, // locations
      { status: 200, body: [{ active: true, state: "CA" }] }, // work_addresses
      {
        status: 200,
        body: {
          requirement_sets: [{ key: "taxrates", requirements: [{ key: "usedefaultsuirates", editable: true }] }],
        },
      }, // GET tax_requirements/CA (submittable)
      { status: 422, body: { errors: [{ message: "bad" }] } }, // PUT tax_requirements/CA fails
      { status: 200, body: [{ state: "CA", ready_to_run_payroll: false }] }, // GET tax_requirements
    ]);
    const d = data(await stateTaxHandler(auth)(ctx));
    expect(d.results as { state: string; status: string }[]).toContainEqual(
      expect.objectContaining({ state: "CA", status: "error" }),
    );
  });

  test("surfaces a work-address fetch failure via partial_errors / details", async () => {
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1" }] }, // employees
      { status: 200, body: [] }, // locations
      { status: 404, body: { error: "not found" } }, // work_addresses fetch fails (not retried)
    ]);
    const result = await stateTaxHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("no_work_addresses");
    expect(JSON.stringify(result.error.details)).toContain("work_addresses:emp-1");
  });

  test("a state with no default rate is reported needs_manual_setup with a reason", async () => {
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1" }] }, // employees
      { status: 200, body: [] }, // locations
      { status: 200, body: [{ active: true, state: "NY" }] }, // work_addresses (NY = no temp rate)
      { status: 200, body: { requirement_sets: [] } }, // GET tax_requirements/NY
      { status: 200, body: [{ state: "NY", ready_to_run_payroll: false }] }, // GET tax_requirements
    ]);
    const d = data(await stateTaxHandler(auth)(ctx));
    const ny = (d.results as { state: string; status: string; reason?: string }[]).find((r) => r.state === "NY");
    expect(ny?.status).toBe("needs_manual_setup");
    expect(ny?.reason).toContain("no new-employer default rate");
  });

  test("surfaces a readiness-readback failure via partial_errors", async () => {
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1" }] }, // employees
      { status: 200, body: [] }, // locations
      { status: 200, body: [{ active: true, state: "CA" }] }, // work_addresses
      { status: 200, body: { requirement_sets: [] } }, // GET tax_requirements/CA (no default rate)
      { status: 404, body: { error: "nope" } }, // GET tax_requirements (readiness) fails
    ]);
    const d = data(await stateTaxHandler(auth)(ctx));
    expect(JSON.stringify(d.partial_errors)).toContain("tax_requirements_status");
  });
});

describe("formsHandler", () => {
  test("hosted flow creates a signing URL via POST /flows", async () => {
    const calls = stubFetch([{ status: 200, body: { url: "https://flows.example/abc" } }]);
    const d = data(await formsHandler(auth, false)(ctx));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/companies/co-1/flows");
    expect(d).toMatchObject({ flow_type: "sign_all_forms", url: "https://flows.example/abc" });
  });

  test("--demo-sign signs each unsigned form from localhost", async () => {
    const calls = stubFetch([
      { status: 200, body: [{ uuid: "f1", requires_signing: true, signed_at: null }] }, // GET forms
      { status: 200, body: {} }, // PUT sign
    ]);
    const d = data(await formsHandler({ ...auth, demoSign: true, signatureText: "Ada Lovelace" })(ctx));
    expect(d).toMatchObject({ forms_signed: 1, total: 1 });
    const sign = calls.find((c) => c.url.includes("/forms/f1/sign"));
    expect(sign?.method).toBe("PUT");
    expect(sign?.body).toMatchObject({
      signature_text: "Ada Lovelace",
      agree: true,
      signed_by_ip_address: "127.0.0.1",
    });
  });

  test("--demo-sign reports nothing to do when all forms are already signed", async () => {
    stubFetch([{ status: 200, body: [{ uuid: "f1", requires_signing: true, signed_at: "2026-01-01T00:00:00Z" }] }]);
    const d = data(await formsHandler({ ...auth, demoSign: true, signatureText: "Ada Lovelace" })(ctx));
    expect(d).toMatchObject({ forms_signed: 0, total: 0 });
  });

  test("--demo-sign reports partial failure when some forms fail to sign", async () => {
    stubFetch([
      {
        status: 200,
        body: [
          { uuid: "f1", requires_signing: true, signed_at: null },
          { uuid: "f2", name: "Form 8655", requires_signing: true, signed_at: null },
        ],
      }, // GET forms
      { status: 200, body: {} }, // PUT f1 sign -> ok
      { status: 500, body: { error: "boom" } }, // PUT f2 sign -> fail
    ]);
    const result = await formsHandler({ ...auth, demoSign: true, signatureText: "Ada Lovelace" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("form_signing_failed");
    expect(result.error.message).toContain("Signed 1 of 2");
    expect((result.error.details as { form: string }[])[0]?.form).toBe("Form 8655");
  });

  test("--demo-sign is refused on production (no API call)", async () => {
    const calls = stubFetch([{ status: 200, body: {} }]);
    const prod: GlobalFlags = { ...globals, env: "production" };
    const result = await formsHandler({ ...auth, demoSign: true, signatureText: "Ada Lovelace" })({
      command: "test",
      globals: prod,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("demo_only");
    expect(calls).toHaveLength(0);
  });
});
