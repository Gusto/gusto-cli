import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import { TEST_CONTEXT as ctx, okData as data } from "../lib/test-support.ts";
import {
  bankAccountBlockers,
  bankAccountHandler,
  federalTaxBlockers,
  federalTaxHandler,
  formsHandler,
  resolveTaxableAsScorp,
  stateTaxHandler,
} from "./company-setup.ts";

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

describe("formsHandler --demo-sign", () => {
  test("requires --signature-text", async () => {
    const result = await formsHandler({ demoSign: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.blocked_on?.[0]?.field).toBe("signature-text");
  });
});
