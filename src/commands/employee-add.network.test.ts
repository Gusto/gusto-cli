import { afterEach, describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import {
  type MockResponse,
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  blockedFields,
  okData,
  stubGlobalFetch,
} from "../lib/test-support.ts";
import { workAddressHandler } from "./employee-add.ts";

interface Route extends MockResponse {
  match: string;
}

let restore: () => void = () => {};
afterEach(() => restore());

function routeFetch(routes: Route[]): void {
  restore = stubGlobalFetch((u) => routes.find((rt) => u.includes(rt.match)) ?? { status: 404 }).restore;
}

describe("workAddressHandler default-to-primary", () => {
  test("with --location-uuid: skips the locations lookup and POSTs the override", async () => {
    const fetchStub = stubGlobalFetch((u) => {
      if (u.includes("/work_addresses")) return { status: 201, body: { uuid: "wa-1", location_uuid: "loc-override" } };
      return { status: 404 };
    });
    restore = fetchStub.restore;
    const d = okData(
      await workAddressHandler("emp-1", { ...auth, locationUuid: "loc-override", effectiveDate: "2026-01-01" })(ctx),
    );
    expect(d.location_uuid_used).toBe("loc-override");
    expect(fetchStub.calls.some((c) => c.url.includes("/locations"))).toBe(false);
    const postCall = fetchStub.calls.find((c) => c.url.includes("/work_addresses"));
    expect(postCall?.method).toBe("POST");
    expect((postCall?.body as Record<string, unknown>).location_uuid).toBe("loc-override");
  });

  test("without --location-uuid: looks up the primary location and POSTs it", async () => {
    routeFetch([
      {
        match: "/companies/co-1/locations",
        status: 200,
        body: [{ uuid: "loc-1" }, { uuid: "loc-primary", primary: true }],
      },
      { match: "/work_addresses", status: 201, body: { uuid: "wa-1" } },
    ]);
    const d = okData(await workAddressHandler("emp-1", { ...auth, effectiveDate: "2026-01-01" })(ctx));
    expect(d.location_uuid_used).toBe("loc-primary");
  });

  test("without --location-uuid and zero locations: blocks with location-uuid before POSTing", async () => {
    const fetchStub = stubGlobalFetch((u) => {
      if (u.includes("/locations")) return { status: 200, body: [] };
      return { status: 500, body: { error: "should not be called" } };
    });
    restore = fetchStub.restore;
    const result = await workAddressHandler("emp-1", { ...auth, effectiveDate: "2026-01-01" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toContain("location-uuid");
    expect(fetchStub.calls.some((c) => c.url.includes("/work_addresses"))).toBe(false);
  });

  test("--effective-date is still required up front", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 500 }));
    restore = fetchStub.restore;
    const result = await workAddressHandler("emp-1", { ...auth, locationUuid: "loc-1" })(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["effective-date"]);
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("--dry-run with --location-uuid prints the request body and never calls the API", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 500 }));
    restore = fetchStub.restore;
    const result = await workAddressHandler("emp-1", {
      ...auth,
      locationUuid: "loc-1",
      effectiveDate: "2026-01-01",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({
      method: "POST",
      path: "/v1/employees/emp-1/work_addresses",
      body: { location_uuid: "loc-1", effective_date: "2026-01-01" },
    });
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("--dry-run without --location-uuid notes the deferred primary-location resolution", async () => {
    const result = await workAddressHandler("emp-1", { ...auth, effectiveDate: "2026-01-01", dryRun: true })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toMatchObject({
      method: "POST",
      path: "/v1/employees/emp-1/work_addresses",
    });
    expect((result.data as { note: string }).note).toContain("primary location");
  });
});
