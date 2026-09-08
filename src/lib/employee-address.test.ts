import { describe, expect, test } from "bun:test";
import { buildHomeAddressUpdate, buildWorkAddressUpdate } from "./employee-address.ts";

describe("buildHomeAddressUpdate", () => {
  test("maps only the provided flags to their snake_case API fields", () => {
    const result = buildHomeAddressUpdate({ street1: "1 Main", city: "Denver", state: "CO", zip: "80202" });
    expect(result).toEqual({ ok: true, body: { street_1: "1 Main", city: "Denver", state: "CO", zip: "80202" } });
  });

  test("parses courtesy-withholding into a boolean", () => {
    expect(buildHomeAddressUpdate({ courtesyWithholding: "true" })).toEqual({
      ok: true,
      body: { courtesy_withholding: true },
    });
    expect(buildHomeAddressUpdate({ courtesyWithholding: "false" })).toEqual({
      ok: true,
      body: { courtesy_withholding: false },
    });
  });

  test("rejects a non-boolean courtesy-withholding", () => {
    const result = buildHomeAddressUpdate({ courtesyWithholding: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked.map((b) => b.field)).toContain("courtesy-withholding");
  });

  test("rejects a malformed effective-date and keeps the field name", () => {
    const result = buildHomeAddressUpdate({ street1: "1 Main", effectiveDate: "08-01-2026" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toContainEqual(expect.objectContaining({ field: "effective-date" }));
  });

  test("passes a valid effective-date through unchanged", () => {
    expect(buildHomeAddressUpdate({ effectiveDate: "2026-08-01" })).toEqual({
      ok: true,
      body: { effective_date: "2026-08-01" },
    });
  });

  test("a version-only payload is nothing to update (blocked)", () => {
    const result = buildHomeAddressUpdate({ recordVersion: "v1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("nothing to update");
  });

  test("includes a caller-supplied version alongside an address field", () => {
    expect(buildHomeAddressUpdate({ city: "Denver", recordVersion: "v1" })).toEqual({
      ok: true,
      body: { city: "Denver", version: "v1" },
    });
  });

  test("rejects an empty address field instead of blanking it on a partial update", () => {
    const result = buildHomeAddressUpdate({ city: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toContainEqual(expect.objectContaining({ field: "city" }));
  });

  test("rejects a whitespace-only address field", () => {
    const result = buildHomeAddressUpdate({ city: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toContainEqual(expect.objectContaining({ field: "city" }));
  });

  test("trims surrounding whitespace from a field value", () => {
    expect(buildHomeAddressUpdate({ city: "  Denver  " })).toEqual({ ok: true, body: { city: "Denver" } });
  });

  test("rejects an empty --record-version (which would otherwise silently auto-fetch)", () => {
    const result = buildHomeAddressUpdate({ city: "Denver", recordVersion: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toContainEqual(expect.objectContaining({ field: "record-version" }));
  });
});

describe("buildWorkAddressUpdate", () => {
  test("maps location-uuid and effective-date to their API fields", () => {
    expect(buildWorkAddressUpdate({ locationUuid: "loc-1", effectiveDate: "2026-08-01" })).toEqual({
      ok: true,
      body: { location_uuid: "loc-1", effective_date: "2026-08-01" },
    });
  });

  test("rejects a malformed effective-date", () => {
    const result = buildWorkAddressUpdate({ effectiveDate: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toContainEqual(expect.objectContaining({ field: "effective-date" }));
  });

  test("an empty payload is nothing to update (blocked)", () => {
    const result = buildWorkAddressUpdate({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBe("nothing to update");
  });

  test("includes a caller-supplied version alongside a field", () => {
    expect(buildWorkAddressUpdate({ locationUuid: "loc-1", recordVersion: "v1" })).toEqual({
      ok: true,
      body: { location_uuid: "loc-1", version: "v1" },
    });
  });

  test("rejects an empty --location-uuid", () => {
    const result = buildWorkAddressUpdate({ locationUuid: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toContainEqual(expect.objectContaining({ field: "location-uuid" }));
  });
});
