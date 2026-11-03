import { afterEach, describe, expect, test } from "bun:test";
import { updateHomeAddressHandler, updateWorkAddressHandler } from "./employee.ts";
import { ExitCode } from "../lib/exit-codes.ts";
import { TEST_CONTEXT as ctx, blockedFields, okData, routeFetch } from "../lib/test-support.ts";

// The address uuid is validated before the body is built, so these have to be well-formed.
const HA_UUID = "1a2b3c4d-0000-4111-2222-333344445555";
const WA_UUID = "9b8c7d6e-0000-4111-2222-333344445555";

// These handlers are thin: they build a body and delegate to putResourceWithVersion. The
// optimistic-concurrency version dance (auto-fetch, caller-version-wins, version_unresolved, the
// toResult error path) is unit-tested against putResourceWithVersion in lib/api-context.test.ts, so
// the tests here cover only handler-level concerns: endpoint selection, --example, the agent-mode
// gate, and validation delegation. Handler wiring is exercised through --dry-run, which returns the
// built request without touching the network.

describe("updateHomeAddressHandler", () => {
  test("builds the body and targets the home_addresses endpoint", async () => {
    const d = okData(await updateHomeAddressHandler(HA_UUID, { street1: "1 Main", city: "Denver", dryRun: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe(`/v1/home_addresses/${HA_UUID}`);
    expect(d.body).toEqual({ street_1: "1 Main", city: "Denver" });
  });

  test("--example prints a canned payload without calling the API", async () => {
    const d = okData(await updateHomeAddressHandler(HA_UUID, { example: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/home_addresses/{home_address_uuid}");
    expect((d.body as Record<string, unknown>).street_1).toBeDefined();
  });

  test("no address fields is a validation failure (exit 7)", async () => {
    const result = await updateHomeAddressHandler(HA_UUID, { confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(blockedFields(result)).toContain("fields");
  });

  test("an agent-mode write without --confirm is blocked (exit 8)", async () => {
    const result = await updateHomeAddressHandler(HA_UUID, { city: "Denver" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(8);
    expect(result.error.code).toBe("confirmation_required");
  });
});

describe("updateWorkAddressHandler", () => {
  test("builds the body and targets the work_addresses endpoint", async () => {
    const d = okData(await updateWorkAddressHandler(WA_UUID, { locationUuid: "loc-1", dryRun: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe(`/v1/work_addresses/${WA_UUID}`);
    expect(d.body).toEqual({ location_uuid: "loc-1" });
  });

  test("--example prints a canned payload without calling the API", async () => {
    const d = okData(await updateWorkAddressHandler(WA_UUID, { example: true })(ctx));
    expect(d.path).toBe("/v1/work_addresses/{work_address_uuid}");
    expect((d.body as Record<string, unknown>).location_uuid).toBeDefined();
  });

  test("no fields is a validation failure (exit 7)", async () => {
    const result = await updateWorkAddressHandler(WA_UUID, { confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(7);
    expect(blockedFields(result)).toContain("fields");
  });
});

describe("updateWorkAddressHandler for employees who work at more than one location", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  const EMP_UUID = "3f2a8c1d-0000-4111-2222-333344445555";
  const address = { uuid: WA_UUID, employee_uuid: EMP_UUID, version: "v1", active: true };

  function routes(employeeAddresses: unknown[]) {
    const s = routeFetch([
      { match: `/v1/employees/${EMP_UUID}/work_addresses`, status: 200, body: employeeAddresses },
      { match: `/v1/work_addresses/${WA_UUID}`, status: 200, body: address },
    ]);
    restore = s.restore;
    return s;
  }

  test("more than one active work address is refused and nothing is PUT", async () => {
    const s = routes([address, { ...address, uuid: "wa-2" }]);
    const result = await updateWorkAddressHandler(WA_UUID, { locationUuid: "loc-1", confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("multi_location_not_supported");
    expect(result.error.employee_uuids).toEqual([EMP_UUID]);
    expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("one active work address goes through to the PUT", async () => {
    const s = routes([address, { ...address, uuid: "wa-old", active: false }]);
    okData(await updateWorkAddressHandler(WA_UUID, { locationUuid: "loc-1", confirm: true })(ctx));
    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ location_uuid: "loc-1", version: "v1" });
  });

  test("a failed employee lookup says nothing was written", async () => {
    const s = routeFetch([{ match: `/v1/work_addresses/${WA_UUID}`, status: 200, body: address }]);
    restore = s.restore;
    const result = await updateWorkAddressHandler(WA_UUID, { locationUuid: "loc-1", confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("nothing was written");
    expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("--dry-run still needs no auth or reads", async () => {
    const s = routes([address, { ...address, uuid: "wa-2" }]);
    const d = okData(await updateWorkAddressHandler(WA_UUID, { locationUuid: "loc-1", dryRun: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(s.calls).toHaveLength(0);
  });
});
