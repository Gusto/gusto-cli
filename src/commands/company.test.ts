import { describe, expect, test } from "bun:test";
import { type CompanyShowData, renderCompanyShow } from "./company.ts";

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
