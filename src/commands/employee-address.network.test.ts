import { describe, expect, test } from "bun:test";
import { updateHomeAddressHandler, updateWorkAddressHandler } from "./employee.ts";
import { TEST_CONTEXT as ctx, blockedFields, okData } from "../lib/test-support.ts";

// These handlers are thin: they build a body and delegate to putResourceWithVersion. The
// optimistic-concurrency version dance (auto-fetch, caller-version-wins, version_unresolved, the
// toResult error path) is unit-tested against putResourceWithVersion in lib/api-context.test.ts, so
// the tests here cover only handler-level concerns: endpoint selection, URL encoding, --example, the
// agent-mode gate, and validation delegation. Handler wiring is exercised through --dry-run, which
// returns the built request without touching the network.

describe("updateHomeAddressHandler", () => {
  test("builds the body and targets the home_addresses endpoint", async () => {
    const d = okData(await updateHomeAddressHandler("ha-1", { street1: "1 Main", city: "Denver", dryRun: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/home_addresses/ha-1");
    expect(d.body).toEqual({ street_1: "1 Main", city: "Denver" });
  });

  test("URL-encodes an address uuid with significant characters into a single segment", async () => {
    const d = okData(await updateHomeAddressHandler("a/b?c#d", { city: "Denver", dryRun: true })(ctx));
    expect(d.path).toBe("/v1/home_addresses/a%2Fb%3Fc%23d");
  });

  test("--example prints a canned payload without calling the API", async () => {
    const d = okData(await updateHomeAddressHandler("ha-1", { example: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/home_addresses/{home_address_uuid}");
    expect((d.body as Record<string, unknown>).street_1).toBeDefined();
  });

  test("no address fields is a validation failure (exit 7)", async () => {
    const result = await updateHomeAddressHandler("ha-1", { confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(blockedFields(result)).toContain("fields");
  });

  test("an agent-mode write without --confirm is blocked (exit 8)", async () => {
    const result = await updateHomeAddressHandler("ha-1", { city: "Denver" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(8);
    expect(result.error.code).toBe("confirmation_required");
  });
});

describe("updateWorkAddressHandler", () => {
  test("builds the body and targets the work_addresses endpoint", async () => {
    const d = okData(await updateWorkAddressHandler("wa-1", { locationUuid: "loc-1", dryRun: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/work_addresses/wa-1");
    expect(d.body).toEqual({ location_uuid: "loc-1" });
  });

  test("--example prints a canned payload without calling the API", async () => {
    const d = okData(await updateWorkAddressHandler("wa-1", { example: true })(ctx));
    expect(d.path).toBe("/v1/work_addresses/{work_address_uuid}");
    expect((d.body as Record<string, unknown>).location_uuid).toBeDefined();
  });

  test("no fields is a validation failure (exit 7)", async () => {
    const result = await updateWorkAddressHandler("wa-1", { confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(blockedFields(result)).toContain("fields");
  });
});
