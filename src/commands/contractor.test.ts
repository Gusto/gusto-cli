import { describe, expect, test } from "bun:test";
import { validateContractorAdd } from "./contractor.ts";

describe("validateContractorAdd", () => {
  test("individual with all required fields returns the populated body", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "2026-06-03",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        type: "Individual",
        first_name: "Sam",
        last_name: "Rivera",
        email: "s@x.com",
        wage_type: "Fixed",
        start_date: "2026-06-03",
        self_onboarding: false,
      },
    });
  });

  test("self_onboarding defaults to false and is true only when opted in", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "2026-06-03",
      selfOnboarding: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body.self_onboarding).toBe(true);
  });

  test("hourly individual includes the hourly_rate", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "hourly",
      startDate: "2026-06-03",
      hourlyRate: "45",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        type: "Individual",
        first_name: "Sam",
        last_name: "Rivera",
        email: "s@x.com",
        wage_type: "Hourly",
        start_date: "2026-06-03",
        hourly_rate: "45",
        self_onboarding: false,
      },
    });
  });

  test("business with all required fields returns the populated body", () => {
    const result = validateContractorAdd({
      type: "business",
      businessName: "Acme LLC",
      email: "b@acme.com",
      wageType: "fixed",
      startDate: "2026-06-03",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        type: "Business",
        business_name: "Acme LLC",
        email: "b@acme.com",
        wage_type: "Fixed",
        start_date: "2026-06-03",
        self_onboarding: false,
      },
    });
  });

  test("missing --type blocks on type with the type-specific message", () => {
    const result = validateContractorAdd({ email: "s@x.com" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("missing or invalid --type");
    expect(result.blocked).toEqual([{ field: "type", reason: "must be 'individual' or 'business'" }]);
  });

  test("an unknown --type value is rejected", () => {
    const result = validateContractorAdd({ type: "freelancer" as never, email: "s@x.com" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "type" }));
  });

  test("missing wage-type and start-date block even when identity fields are present", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "wage-type" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
  });

  test("an invalid --wage-type value is rejected", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "salaried",
      startDate: "2026-06-03",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "wage-type" }));
  });

  test("a malformed --start-date is rejected", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "06/03/2026",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
  });

  test("a regex-valid but calendar-impossible --start-date is rejected", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "2026-02-30",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
  });

  test("hourly wage-type without --hourly-rate blocks on hourly-rate", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "hourly",
      startDate: "2026-06-03",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "hourly-rate" }));
  });

  test("a non-positive --hourly-rate is rejected", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "hourly",
      startDate: "2026-06-03",
      hourlyRate: "0",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "hourly-rate" }));
  });

  test("--hourly-rate passed with fixed wage-type is rejected, not silently dropped", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "fixed",
      startDate: "2026-06-03",
      hourlyRate: "50",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "hourly-rate" }));
  });

  test("individual missing names blocks on names plus wage/start (email is admin-driven optional)", () => {
    const result = validateContractorAdd({ type: "individual" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("missing or invalid arguments");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "first-name" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "last-name" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "wage-type" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "start-date" }));
    // Admin-driven is the default, so email is not required.
    expect(result.blocked).not.toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("admin-driven contractor without --email succeeds and omits email from the body", () => {
    const result = validateContractorAdd({
      type: "business",
      businessName: "Acme LLC",
      wageType: "fixed",
      startDate: "2026-06-03",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        type: "Business",
        business_name: "Acme LLC",
        wage_type: "Fixed",
        start_date: "2026-06-03",
        self_onboarding: false,
      },
    });
  });

  test("--self-onboarding requires --email", () => {
    const result = validateContractorAdd({
      type: "business",
      businessName: "Acme LLC",
      wageType: "fixed",
      startDate: "2026-06-03",
      selfOnboarding: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("hourly_rate is normalized to the validated value, not the raw input", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
      wageType: "hourly",
      startDate: "2026-06-03",
      hourlyRate: "1e3",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.body).toEqual(expect.objectContaining({ wage_type: "Hourly", hourly_rate: "1000" }));
  });

  test("business does not require first/last name, only business-name + email + wage/start", () => {
    const result = validateContractorAdd({
      type: "business",
      email: "b@acme.com",
      wageType: "fixed",
      startDate: "2026-06-03",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toEqual([{ field: "business-name", reason: "required for business" }]);
  });
});
