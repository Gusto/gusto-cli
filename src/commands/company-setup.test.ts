import { describe, expect, test } from "bun:test";
import { ApiError } from "../lib/api-client.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { TEST_CONTEXT as ctx, okData as data } from "../lib/test-support.ts";
import {
  addressBlockers,
  addressHandler,
  bankAccountBlockers,
  bankAccountHandler,
  einAlreadyInUse,
  federalTaxBlockers,
  federalTaxHandler,
  formsHandler,
  industryBlockers,
  industryHandler,
  resolveTaxableAsScorp,
  signatoryBlockers,
  signatoryHandler,
  stateTaxHandler,
} from "./company-setup.ts";

describe("einAlreadyInUse", () => {
  const err = (status: number, body: unknown) => new ApiError(status, body, ExitCode.ApiClient, `PUT x -> ${status}`);

  test("true for a 422 with an 'already in use' message in errors[]", () => {
    expect(einAlreadyInUse(err(422, { errors: [{ message: "EIN is already in use" }] }))).toBe(true);
  });
  test("true for a 422 with a top-level error string", () => {
    expect(einAlreadyInUse(err(422, { error: "That EIN is already in use" }))).toBe(true);
  });
  test("false for a non-422", () => {
    expect(einAlreadyInUse(err(409, { errors: [{ message: "EIN is already in use" }] }))).toBe(false);
  });
  test("false when 'ein' and 'already in use' are in separate errors (no cross-splice)", () => {
    expect(
      einAlreadyInUse(err(422, { errors: [{ message: "EIN is required" }, { message: "name already in use" }] })),
    ).toBe(false);
  });
  test("false for a non-ApiError", () => {
    expect(einAlreadyInUse(new Error("boom"))).toBe(false);
  });
});

describe("federalTaxBlockers", () => {
  test("flags every missing field", () => {
    expect(federalTaxBlockers({}).map((b) => b.field)).toEqual(["ein", "tax-payer-type", "filing-form", "legal-name"]);
  });

  test("no blockers when all present", () => {
    expect(
      federalTaxBlockers({ ein: "12-3456789", taxPayerType: "LLC", filingForm: "941", legalName: "Acme" }),
    ).toEqual([]);
  });
});

describe("resolveTaxableAsScorp", () => {
  test("explicit flag wins", () => {
    expect(resolveTaxableAsScorp({ taxableAsScorp: true })).toBe(true);
  });
  test("auto-on for S-Corporation", () => {
    expect(resolveTaxableAsScorp({ taxPayerType: "S-Corporation" })).toBe(true);
  });
  test("undefined otherwise", () => {
    expect(resolveTaxableAsScorp({ taxPayerType: "LLC" })).toBeUndefined();
  });
});

describe("federalTaxHandler", () => {
  test("refuses with a structured blocked_on when args are missing", async () => {
    const result = await federalTaxHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.blocked_on).toHaveLength(4);
  });

  test("dry-run builds the PUT request shape without sending", async () => {
    const result = await federalTaxHandler({
      ein: "12-3456789",
      taxPayerType: "S-Corporation",
      filingForm: "941",
      legalName: "Acme Inc.",
      dryRun: true,
    })(ctx);
    const d = data(result);
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/companies/{company_uuid}/federal_tax_details");
    expect(d.body).toMatchObject({ ein: "12-3456789", taxable_as_scorp: true });
  });

  test("example returns a canned payload", async () => {
    const d = data(await federalTaxHandler({ example: true })(ctx));
    expect(d.method).toBe("PUT");
  });
});

describe("bankAccountBlockers + handler", () => {
  test("flags missing fields", () => {
    expect(bankAccountBlockers({}).map((b) => b.field)).toEqual(["routing", "account-number", "account-type"]);
  });

  test("dry-run builds the POST shape", async () => {
    const d = data(
      await bankAccountHandler({
        routing: "123456789",
        accountNumber: "1234567890",
        accountType: "Checking",
        dryRun: true,
      })(ctx),
    );
    expect(d.method).toBe("POST");
    expect(d.path).toBe("/v1/companies/{company_uuid}/bank_accounts");
    expect(d.body).toMatchObject({ routing_number: "123456789", account_type: "Checking" });
  });

  test("missing args refuse with blocked_on", async () => {
    const result = await bankAccountHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
  });

  test("--example returns a canned payload", async () => {
    const d = data(await bankAccountHandler({ example: true })(ctx));
    expect(d.method).toBe("POST");
    expect(d.path).toContain("/bank_accounts");
  });
});

describe("stateTaxHandler", () => {
  test("dry-run describes the discovery-driven flow", async () => {
    const d = data(await stateTaxHandler({ dryRun: true })(ctx));
    expect(d.temporary_rate_states).toEqual(["CA", "TX", "FL"]);
    expect(d.use_temporary_rates).toBe(true);
  });

  test("--no-temporary-rates is reflected", async () => {
    const d = data(await stateTaxHandler({ dryRun: true, temporaryRates: false })(ctx));
    expect(d.use_temporary_rates).toBe(false);
  });
});

describe("signatoryBlockers + handler", () => {
  test("flags every missing field", () => {
    expect(signatoryBlockers({}).map((b) => b.field)).toEqual(["first-name", "last-name", "email"]);
  });

  test("no blockers when name + email present (title optional)", () => {
    expect(signatoryBlockers({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" })).toEqual([]);
  });

  test("missing args refuse with a structured blocked_on", async () => {
    const result = await signatoryHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.blocked_on).toHaveLength(3);
  });

  test("dry-run builds the invite POST shape without sending", async () => {
    const d = data(
      await signatoryHandler({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", dryRun: true })(ctx),
    );
    expect(d.method).toBe("POST");
    expect(d.path).toBe("/v1/companies/{company_uuid}/signatories/invite");
    expect(d.body).toEqual({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" });
  });

  test("--example returns a canned payload", async () => {
    const d = data(await signatoryHandler({ example: true })(ctx));
    expect(d.method).toBe("POST");
    expect(d.path).toContain("/signatories/invite");
  });
});

describe("formsHandler --demo-sign", () => {
  test("requires --signature-text", async () => {
    const result = await formsHandler({ demoSign: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.blocked_on?.[0]?.field).toBe("signature-text");
  });
});

describe("addressBlockers + handler", () => {
  test("flags every missing field", () => {
    expect(addressBlockers({}).map((b) => b.field)).toEqual(["street-1", "city", "state", "zip", "phone"]);
  });

  test("flags phone alone when other fields are present", () => {
    expect(
      addressBlockers({ street1: "1 Main St", city: "SF", state: "CA", zip: "94107" }).map((b) => b.field),
    ).toEqual(["phone"]);
  });

  test("no blockers when street/city/state/zip/phone present", () => {
    expect(
      addressBlockers({ street1: "1 Main St", city: "SF", state: "CA", zip: "94107", phone: "4155550100" }),
    ).toEqual([]);
  });

  test("missing args refuse with a structured blocked_on", async () => {
    const result = await addressHandler({})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.blocked_on).toHaveLength(5);
  });

  test("dry-run builds the POST shape; filing + mailing default true", async () => {
    const d = data(
      await addressHandler({
        street1: "300 3rd St",
        city: "San Francisco",
        state: "CA",
        zip: "94107",
        phone: "4155550100",
        dryRun: true,
      })(ctx),
    );
    expect(d.method).toBe("POST");
    expect(d.path).toBe("/v1/companies/{company_uuid}/locations");
    expect(d.body).toEqual({
      street_1: "300 3rd St",
      city: "San Francisco",
      state: "CA",
      zip: "94107",
      phone_number: "4155550100",
      filing_address: true,
      mailing_address: true,
    });
  });

  test("--no-filing-address / --no-mailing-address opt out", async () => {
    const d = data(
      await addressHandler({
        street1: "300 3rd St",
        city: "San Francisco",
        state: "CA",
        zip: "94107",
        phone: "4155550100",
        filingAddress: false,
        mailingAddress: false,
        dryRun: true,
      })(ctx),
    );
    expect(d.body).toMatchObject({ filing_address: false, mailing_address: false });
  });

  test("--example returns a canned payload", async () => {
    const d = data(await addressHandler({ example: true })(ctx));
    expect(d.method).toBe("POST");
    expect(d.path).toContain("/locations");
  });
});

describe("industryBlockers + handler", () => {
  test("flags missing naics-code", () => {
    expect(industryBlockers({}).map((b) => b.field)).toEqual(["naics-code"]);
  });

  test("no blockers when naics-code present (title + sic optional)", () => {
    expect(industryBlockers({ naicsCode: "541511" })).toEqual([]);
  });

  test("dry-run builds the PUT shape; title + sic omitted when absent", async () => {
    const d = data(await industryHandler({ naicsCode: "541511", dryRun: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/companies/{company_uuid}/industry_selection");
    expect(d.body).toEqual({ naics_code: "541511" });
  });

  test("dry-run includes title + sic_codes when provided", async () => {
    const d = data(
      await industryHandler({ naicsCode: "541511", title: "Software", sicCode: ["7372", "7371"], dryRun: true })(ctx),
    );
    expect(d.body).toEqual({ naics_code: "541511", title: "Software", sic_codes: ["7372", "7371"] });
  });

  test("--example returns a canned payload", async () => {
    const d = data(await industryHandler({ example: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toContain("/industry_selection");
  });
});
