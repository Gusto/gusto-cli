import { afterEach, describe, expect, test } from "bun:test";
import type { GlobalFlags } from "../lib/global-flags.ts";
import {
  addressHandler,
  bankAccountHandler,
  federalTaxHandler,
  formsHandler,
  industryHandler,
  signatoryHandler,
  stateTaxHandler,
} from "./company-setup.ts";
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

    const warnings: string[] = [];
    const d = data(
      await federalTaxHandler(
        {
          ...auth,
          ein: "12-3456789",
          taxPayerType: "LLC",
          filingForm: "941",
          legalName: "Acme Inc.",
        },
        (m) => warnings.push(m),
      )(ctx),
    );

    expect(calls).toHaveLength(4);
    expect(d.ein_auto_rotated).toBe(true);
    expect(d.ein_provided).toBe("12-3456789");
    expect(d.ein_used).not.toBe("12-3456789");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/EIN 12-3456789 was already in use; rotated to .+ \(sandbox only\)\./);
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
    const warnings: string[] = [];
    const result = await federalTaxHandler(
      {
        ...auth,
        ein: "12-3456789",
        taxPayerType: "LLC",
        filingForm: "941",
        legalName: "Acme Inc.",
      },
      (m) => warnings.push(m),
    )({ ...ctx, globals: prod });

    expect(result.ok).toBe(false);
    // GET + one PUT only - no fabricated-EIN retry.
    expect(calls).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  test("ein_rotation_failed when the fabricated EIN also collides", async () => {
    const calls = stubFetch([
      { status: 200, body: { version: "v1" } }, // GET
      { status: 422, body: { errors: [{ message: "EIN is already in use" }] } }, // PUT -> rotate
      { status: 200, body: { version: "v2" } }, // GET (retry)
      { status: 422, body: { errors: [{ message: "EIN is already in use" }] } }, // PUT (rotated) also fails
    ]);
    const warnings: string[] = [];
    const result = await federalTaxHandler(
      {
        ...auth,
        ein: "12-3456789",
        taxPayerType: "LLC",
        filingForm: "941",
        legalName: "Acme Inc.",
      },
      (m) => warnings.push(m),
    )(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("ein_rotation_failed");
    expect(result.error.details).toMatchObject({ ein_provided: "12-3456789" });
    expect(calls).toHaveLength(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/EIN 12-3456789 was already in use; rotated to .+/);
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

  test("surfaces the completed bank account + failed phase when verify fails after create", async () => {
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
    expect(result.error.details).toMatchObject({
      bank_account: "bank-1",
      completed: ["bank_account"],
      failed: {
        domain: "verify",
        // The server's 422 body is preserved (structured) under failed.error.details.
        error: { details: { errors: [{ message: "amounts do not match" }] } },
      },
    });
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
    expect(result.error.details).toMatchObject({ failed: { domain: "send_test_deposits" } });
    // No verify PUT should have been attempted with bad amounts.
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("an empty-string deposit amount is rejected (Number('') is 0, finite)", async () => {
    const calls = stubFetch([
      { status: 201, body: { uuid: "bank-1" } },
      { status: 200, body: { deposit_1: "", deposit_2: "0.03" } },
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
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("a create response without a uuid fails before any follow-up call", async () => {
    const calls = stubFetch([{ status: 201, body: {} }]); // no uuid
    const result = await bankAccountHandler({
      ...auth,
      routing: "123456789",
      accountNumber: "987654321",
      accountType: "Checking",
    })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("bank_create_no_uuid");
    expect(calls).toHaveLength(1); // only the create POST
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
      // The API requires `state` on every requirement_set; without it the PUT 422s.
      requirement_sets: [{ state: "CA", key: "taxrates", requirements: [{ key: "usedefaultsuirates", value: true }] }],
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

  test("does not report ready:true for a state whose submit errored, even if the readback says ready", async () => {
    // Secondary case: the readback reflects out-of-band state. A failed submit
    // this run must not be masked as ready by a stale/optimistic readback.
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1" }] }, // employees
      { status: 200, body: [] }, // locations
      { status: 200, body: [{ active: true, state: "CA" }] }, // work_addresses
      {
        status: 200,
        body: {
          requirement_sets: [{ key: "taxrates", requirements: [{ key: "usedefaultsuirates", editable: true }] }],
        },
      }, // GET tax_requirements/CA (submittable)
      { status: 422, body: { errors: [{ message: "bad" }] } }, // PUT tax_requirements/CA fails
      { status: 200, body: [{ state: "CA", ready_to_run_payroll: true }] }, // readback claims ready
    ]);
    const d = data(await stateTaxHandler(auth)(ctx));
    expect(d.ready).toBe(false);
    expect(d.results as { state: string; status: string }[]).toContainEqual(
      expect.objectContaining({ state: "CA", status: "error" }),
    );
  });

  test("records no_location_to_provision when an employee needs a work address but there's no location", async () => {
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1", jobs: [{}] }] }, // employees (has job)
      { status: 200, body: [] }, // locations: none to back-fill from
      { status: 200, body: [] }, // work_addresses: none
    ]);
    const result = await stateTaxHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(JSON.stringify(result.error.details)).toContain("no_location_to_provision:emp-1");
  });

  test("labels a reload failure after a successful back-fill POST as reload_work_addresses", async () => {
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1", jobs: [{}] }] }, // employees (has job)
      { status: 200, body: [{ uuid: "loc-1" }] }, // locations
      { status: 200, body: [] }, // work_addresses: none
      { status: 201, body: {} }, // POST work_addresses succeeds
      { status: 404, body: { error: "gone" } }, // reload GET fails
    ]);
    const result = await stateTaxHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const details = JSON.stringify(result.error.details);
    expect(details).toContain("reload_work_addresses:emp-1");
    expect(details).not.toContain("provision_work_address");
  });

  test("records provision_work_address in partial_errors when the back-fill POST fails", async () => {
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1", jobs: [{}] }] }, // employees (has job)
      { status: 200, body: [{ uuid: "loc-1" }] }, // locations
      { status: 200, body: [] }, // work_addresses: none
      { status: 422, body: { error: "cannot assign" } }, // POST work_addresses fails
    ]);
    const result = await stateTaxHandler(auth)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("no_work_addresses");
    expect(JSON.stringify(result.error.details)).toContain("provision_work_address:emp-1");
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

  test("a supported state without an editable default-rate flag is no_default_rate_question", async () => {
    stubFetch([
      { status: 200, body: [{ uuid: "emp-1" }] }, // employees
      { status: 200, body: [] }, // locations
      { status: 200, body: [{ active: true, state: "CA" }] }, // work_addresses (CA = supported)
      {
        status: 200,
        body: {
          requirement_sets: [{ key: "taxrates", requirements: [{ key: "usedefaultsuirates", editable: false }] }],
        },
      }, // GET tax_requirements/CA - default-rate flag not editable
      { status: 200, body: [{ state: "CA", ready_to_run_payroll: false }] }, // GET tax_requirements
    ]);
    const d = data(await stateTaxHandler(auth)(ctx));
    const ca = (d.results as { state: string; status: string; reason?: string }[]).find((r) => r.state === "CA");
    expect(ca?.status).toBe("no_default_rate_question");
    expect(ca?.reason).toContain("does not expose usedefaultsuirates");
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
  // The hosted flow first checks for a signatory (GET /signatories), then POSTs
  // /flows. A present signatory is a non-empty list.
  const SIGNATORY_PRESENT: MockResponse = { status: 200, body: [{ uuid: "sig-1" }] };

  test("hosted flow checks for a signatory, then creates a signing URL via POST /flows", async () => {
    const calls = stubFetch([SIGNATORY_PRESENT, { status: 200, body: { url: "https://flows.example/abc" } }]);
    const d = data(await formsHandler(auth, false)(ctx));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/companies/co-1/signatories");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toContain("/companies/co-1/flows");
    expect(d).toMatchObject({ flow_type: "sign_all_forms", url: "https://flows.example/abc" });
  });

  test("hosted flow is refused when no signatory is assigned (no /flows POST)", async () => {
    const calls = stubFetch([{ status: 200, body: [] }]); // GET /signatories -> empty
    const result = await formsHandler(auth, false)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("signatory_required");
    expect(calls).toHaveLength(1); // never reached POST /flows
    expect(calls.some((c) => c.url.includes("/flows"))).toBe(false);
  });

  test("--note is passed through as options.note in the /flows body", async () => {
    const calls = stubFetch([SIGNATORY_PRESENT, { status: 200, body: { url: "https://flows.example/abc" } }]);
    await formsHandler({ ...auth, note: "please sign by Friday" }, false)(ctx);
    const flows = calls.find((c) => c.url.includes("/flows"));
    expect(flows?.body).toMatchObject({
      flow_type: "sign_all_forms",
      options: { note: "please sign by Friday" },
    });
  });

  test("interactive TTY mode opens the signing URL in a browser", async () => {
    stubFetch([SIGNATORY_PRESENT, { status: 200, body: { url: "https://flows.example/abc" } }]);
    const ttyCtx = { ...ctx, globals: { ...globals, agent: false, json: false } };
    const opened: string[] = [];
    const d = data(
      await formsHandler(auth, true, async (u) => {
        opened.push(u);
      })(ttyCtx),
    );
    expect(opened).toEqual(["https://flows.example/abc"]);
    expect(d).toMatchObject({ url: "https://flows.example/abc" });
    expect(d.browser_opened).toBeUndefined();
  });

  test("a failed browser open still surfaces the URL and flags browser_opened:false", async () => {
    stubFetch([SIGNATORY_PRESENT, { status: 200, body: { url: "https://flows.example/abc" } }]);
    const ttyCtx = { ...ctx, globals: { ...globals, agent: false, json: false } };
    const d = data(await formsHandler(auth, true, () => Promise.reject(new Error("no browser here")))(ttyCtx));
    expect(d).toMatchObject({ url: "https://flows.example/abc", browser_opened: false });
    expect(String(d.message)).toContain("https://flows.example/abc");
  });

  test("hosted flow with no url in the response fails with flow_no_url", async () => {
    stubFetch([SIGNATORY_PRESENT, { status: 200, body: {} }]); // POST /flows returns no url
    const result = await formsHandler(auth, false)(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("flow_no_url");
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
      ...ctx,
      globals: prod,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("demo_only");
    expect(calls).toHaveLength(0);
  });
});

describe("signatoryHandler (network)", () => {
  test("invites the signatory via POST /signatories/invite", async () => {
    const calls = stubFetch([{ status: 200, body: { uuid: "sig-1" } }]);
    const d = data(
      await signatoryHandler({
        ...auth,
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        title: "CEO",
      })(ctx),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/companies/co-1/signatories/invite");
    expect(calls[0]?.body).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
      email: "ada@example.com",
      title: "CEO",
    });
    expect(d).toMatchObject({ signatory: { uuid: "sig-1" } });
    expect(String(d.message)).toContain("Ada Lovelace");
  });
});

describe("addressHandler (network)", () => {
  test("POSTs /locations with the flat body; filing + mailing default true", async () => {
    const calls = stubFetch([{ status: 201, body: { uuid: "loc-1", street_1: "300 3rd St" } }]);

    const d = data(
      await addressHandler({
        ...auth,
        street1: "300 3rd St",
        city: "San Francisco",
        state: "CA",
        zip: "94107",
        phone: "4155550100",
      })(ctx),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/companies/co-1/locations");
    expect(calls[0]?.body).toEqual({
      street_1: "300 3rd St",
      city: "San Francisco",
      state: "CA",
      zip: "94107",
      phone_number: "4155550100",
      filing_address: true,
      mailing_address: true,
    });
    expect(d).toMatchObject({ location: { uuid: "loc-1" } });
    expect(String(d.message)).toContain("San Francisco, CA (filing address)");
  });

  test("includes street_2 / country when provided and respects --no-filing-address", async () => {
    const calls = stubFetch([{ status: 201, body: { uuid: "loc-2" } }]);

    await addressHandler({
      ...auth,
      street1: "1 Main St",
      street2: "Suite 5",
      city: "Austin",
      state: "TX",
      zip: "73301",
      country: "USA",
      phone: "5125550100",
      filingAddress: false,
    })(ctx);

    expect(calls[0]?.body).toEqual({
      street_1: "1 Main St",
      street_2: "Suite 5",
      city: "Austin",
      state: "TX",
      zip: "73301",
      country: "USA",
      phone_number: "5125550100",
      filing_address: false,
      mailing_address: true,
    });
  });
});

describe("industryHandler (network)", () => {
  test("PUTs /industry_selection with just naics_code when title/sic omitted", async () => {
    const calls = stubFetch([{ status: 201, body: { naics_code: "541511" } }]);

    const d = data(await industryHandler({ ...auth, naicsCode: "541511" })(ctx));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toContain("/companies/co-1/industry_selection");
    expect(calls[0]?.body).toEqual({ naics_code: "541511" });
    expect(d).toMatchObject({ industry: { naics_code: "541511" } });
  });

  test("sends title + sic_codes when provided", async () => {
    const calls = stubFetch([{ status: 201, body: { naics_code: "541511" } }]);

    await industryHandler({ ...auth, naicsCode: "541511", title: "Software", sicCode: ["7372"] })(ctx);

    expect(calls[0]?.body).toEqual({ naics_code: "541511", title: "Software", sic_codes: ["7372"] });
  });
});
