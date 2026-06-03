import { describe, expect, test } from "bun:test";
import { validateContractorAdd } from "./contractor.ts";

describe("validateContractorAdd", () => {
  test("individual with first/last name + email returns the populated body", () => {
    const result = validateContractorAdd({
      type: "individual",
      firstName: "Sam",
      lastName: "Rivera",
      email: "s@x.com",
    });
    expect(result).toEqual({
      ok: true,
      body: { type: "Individual", first_name: "Sam", last_name: "Rivera", email: "s@x.com", self_onboarding: true },
    });
  });

  test("business with business-name + email returns the populated body", () => {
    const result = validateContractorAdd({ type: "business", businessName: "Acme LLC", email: "b@acme.com" });
    expect(result).toEqual({
      ok: true,
      body: { type: "Business", business_name: "Acme LLC", email: "b@acme.com", self_onboarding: true },
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

  test("individual missing names and email blocks on all three", () => {
    const result = validateContractorAdd({ type: "individual" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("missing required arguments");
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "first-name" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "last-name" }));
    expect(result.blocked).toContainEqual(expect.objectContaining({ field: "email" }));
  });

  test("individual missing only email blocks on email alone", () => {
    const result = validateContractorAdd({ type: "individual", firstName: "Sam", lastName: "Rivera" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toEqual([{ field: "email", reason: "required" }]);
  });

  test("business does not require first/last name, only business-name + email", () => {
    const result = validateContractorAdd({ type: "business", email: "b@acme.com" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocked).toEqual([{ field: "business-name", reason: "required for business" }]);
  });
});
