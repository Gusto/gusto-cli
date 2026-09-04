import { afterEach, describe, expect, test } from "bun:test";
import {
  type CompanyShowData,
  companyFederalTaxesHandler,
  companyFormPdfHandler,
  companyFormShowHandler,
  companyFormsListHandler,
  companySignatoriesHandler,
  renderCompanyShow,
} from "./company.ts";
import {
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  okData,
  stubGlobalFetch,
  TEST_COMPANY_UUID,
} from "../lib/test-support.ts";
import { ExitCode } from "../lib/exit-codes.ts";

let restore: () => void = () => {};
afterEach(() => restore());

function showData(overrides: Partial<CompanyShowData> = {}): CompanyShowData {
  const { success, partial_errors, ...rest } = overrides;
  const base = {
    company_uuid: "co-1",
    summary: {
      name: "Acme Inc",
      trade_name: "Acme",
      status: "approved",
      tier: "plus",
      ein: "12-3456789",
      entity_type: "LLC",
      pay_schedule: { frequency: "every_other_week", anchor_pay_date: "2026-01-15" },
    },
    company: null,
    pay_schedules: [{ uuid: "ps-1", frequency: "every_other_week", anchor_pay_date: "2026-01-15" }],
    ...rest,
  };
  return success === false
    ? { ...base, success: false, partial_errors: partial_errors ?? [] }
    : { ...base, success: true };
}

describe("renderCompanyShow", () => {
  test("renders a key-value overview, not JSON", () => {
    const out = renderCompanyShow(showData());
    expect(out).not.toContain("{");
    expect(out).toContain("Acme Inc");
    expect(out).toContain("co-1");
    expect(out).toContain("approved");
    expect(out).toContain("12-3456789");
  });

  test("renders pay schedules as a table", () => {
    const out = renderCompanyShow(showData());
    expect(out).toContain("Pay schedules");
    expect(out).toContain("ps-1");
    expect(out).toContain("every_other_week");
    expect(out).toContain("2026-01-15");
  });

  test("omits missing summary fields but always shows the UUID", () => {
    const out = renderCompanyShow(
      showData({
        summary: {
          name: null,
          trade_name: null,
          status: null,
          tier: null,
          ein: null,
          entity_type: null,
          pay_schedule: null,
        },
        pay_schedules: null,
      }),
    );
    expect(out).toContain("UUID  co-1");
    expect(out).not.toContain("Status");
    expect(out).not.toContain("EIN");
  });

  test("omits the pay-schedules table when there are none", () => {
    expect(renderCompanyShow(showData({ pay_schedules: [] }))).not.toContain("Pay schedules");
    expect(renderCompanyShow(showData({ pay_schedules: null }))).not.toContain("Pay schedules");
  });

  test("surfaces partial_errors as a warning block", () => {
    const out = renderCompanyShow(
      showData({ success: false, partial_errors: [{ label: "pay_schedules", error: "500 server error" }] }),
    );
    expect(out).toContain("pay_schedules");
    expect(out).toContain("500 server error");
  });
});

describe("companyFormsListHandler", () => {
  test("hits /v1/companies/{uuid}/forms and passes the array through", async () => {
    const body = [{ uuid: "form-1", title: "Form 8655" }];
    const stub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = stub.restore;
    const result = await companyFormsListHandler({ ...auth })(ctx);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(stub.calls[0]?.url).toContain(`/v1/companies/${TEST_COMPANY_UUID}/forms`);
    expect(result.data).toEqual(body);
  });

  test("--limit caps the number of forms returned across pages", async () => {
    const body = [
      { uuid: "form-1", title: "Form 8655" },
      { uuid: "form-2", title: "Form 940" },
    ];
    const stub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = stub.restore;
    const result = await companyFormsListHandler({ ...auth, limit: "1" })(ctx);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(stub.calls[0]?.url).toContain(`/v1/companies/${TEST_COMPANY_UUID}/forms`);
    expect(result.data).toEqual([{ uuid: "form-1", title: "Form 8655" }]);
  });

  test("rejects --cursor combined with --all before any request", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restore = stub.restore;
    const result = await companyFormsListHandler({ ...auth, cursor: "abc", all: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(stub.calls.length).toBe(0);
  });

  test("a 404 surfaces as a failed result with the api-client exit code", async () => {
    const stub = stubGlobalFetch(() => ({ status: 404, body: { error: "not found" } }));
    restore = stub.restore;
    const result = await companyFormsListHandler({ ...auth })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });
});

describe("companyFormShowHandler", () => {
  test("hits /v1/forms/{uuid} and passes the body through", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { uuid: "form-1", title: "Form 8655" } }));
    restore = stub.restore;
    const d = okData(await companyFormShowHandler("form-1", {})(ctx));
    expect(stub.calls[0]?.url).toContain("/v1/forms/form-1");
    expect(d).toEqual({ uuid: "form-1", title: "Form 8655" });
  });

  test("percent-encodes the uuid so '../' can't retarget the GET", async () => {
    const stub = stubGlobalFetch(() => ({ status: 404 }));
    restore = stub.restore;
    await companyFormShowHandler("../companies/co-1/signatories", {})(ctx);
    expect(stub.calls[0]?.url).toContain("/v1/forms/..%2Fcompanies%2Fco-1%2Fsignatories");
    expect(stub.calls[0]?.url).not.toContain("/v1/companies/co-1/signatories");
  });

  test("a 404 surfaces as a failed result with the api-client exit code", async () => {
    const stub = stubGlobalFetch(() => ({ status: 404, body: { error: "not found" } }));
    restore = stub.restore;
    const result = await companyFormShowHandler("form-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });
});

describe("companyFormPdfHandler", () => {
  test("hits /v1/forms/{uuid}/pdf and passes the body through", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { document_url: "https://example.test/form.pdf" } }));
    restore = stub.restore;
    const d = okData(await companyFormPdfHandler("form-1", {})(ctx));
    expect(stub.calls[0]?.url).toContain("/v1/forms/form-1/pdf");
    expect(d).toEqual({ document_url: "https://example.test/form.pdf" });
  });

  test("a 404 surfaces as a failed result with the api-client exit code", async () => {
    const stub = stubGlobalFetch(() => ({ status: 404, body: { error: "not found" } }));
    restore = stub.restore;
    const result = await companyFormPdfHandler("form-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });
});

describe("companySignatoriesHandler", () => {
  test("hits /v1/companies/{uuid}/signatories and passes the array through", async () => {
    const body = [{ uuid: "sig-1", title: "CEO" }];
    const stub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = stub.restore;
    const result = await companySignatoriesHandler({ ...auth })(ctx);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(stub.calls[0]?.url).toContain(`/v1/companies/${TEST_COMPANY_UUID}/signatories`);
    expect(result.data).toEqual(body);
  });

  test("a non-array 2xx body is rejected as malformed", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { not: "an array" } }));
    restore = stub.restore;
    const result = await companySignatoriesHandler({ ...auth })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("malformed_response");
  });

  test("a 404 surfaces as a failed result with the api-client exit code", async () => {
    const stub = stubGlobalFetch(() => ({ status: 404, body: { error: "not found" } }));
    restore = stub.restore;
    const result = await companySignatoriesHandler({ ...auth })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });
});

describe("companyFederalTaxesHandler", () => {
  test("hits /v1/companies/{uuid}/federal_tax_details and passes the object through", async () => {
    const body = { ein: "12-3456789", filing_form: "941", tax_payer_type: "LLC" };
    const stub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = stub.restore;
    const d = okData(await companyFederalTaxesHandler({ ...auth })(ctx));
    expect(stub.calls[0]?.url).toContain(`/v1/companies/${TEST_COMPANY_UUID}/federal_tax_details`);
    expect(d).toEqual(body);
  });

  test("a 404 surfaces as a failed result with the api-client exit code", async () => {
    const stub = stubGlobalFetch(() => ({ status: 404, body: { error: "not found" } }));
    restore = stub.restore;
    const result = await companyFederalTaxesHandler({ ...auth })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
  });
});
