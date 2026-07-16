import { afterEach, describe, expect, test } from "bun:test";
import {
  type EmployeeListData,
  type EmployeeListSummary,
  employeeAddressesHandler,
  employeeListHandler,
  homeAddressHandler,
  workAddressHandler,
} from "./employee.ts";
import {
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  blockedFields,
  okData,
  pagedRouter,
  routeFetch,
  stubGlobalFetch,
} from "../lib/test-support.ts";

let restore: () => void = () => {};
afterEach(() => restore());

const FIXTURE = [
  { uuid: "a1", onboarding_status: "onboarding_completed" },
  { uuid: "a2", onboarding_status: "onboarding_completed" },
  { uuid: "b1", onboarding_status: "admin_onboarding_incomplete" },
  { uuid: "t1", terminated: true, onboarding_status: "onboarding_completed" },
];

function stub(status: number, body: unknown): void {
  restore = stubGlobalFetch(() => ({ status, body })).restore;
}

describe("employeeListHandler", () => {
  test("default active: summary holds the full breakdown, employees only the active subset", async () => {
    stub(200, FIXTURE);
    const d = okData(await employeeListHandler({ ...auth })(ctx)) as unknown as EmployeeListData;
    expect(d.summary).toEqual({ total: 4, active: 2, onboarding: 1, terminated: 1, filter_applied: "active" });
    expect(d.employees.map((e) => e.uuid)).toEqual(["a1", "a2"]);
  });

  test("--status all returns every record", async () => {
    stub(200, FIXTURE);
    const d = okData(await employeeListHandler({ ...auth, status: "all" })(ctx)) as unknown as EmployeeListData;
    expect(d.employees).toHaveLength(4);
    expect((d.summary as EmployeeListSummary).filter_applied).toBe("all");
  });

  test("an empty company yields zero counts and an empty list", async () => {
    stub(200, []);
    const d = okData(await employeeListHandler({ ...auth })(ctx)) as unknown as EmployeeListData;
    expect(d.summary?.total).toBe(0);
    expect(d.employees).toHaveLength(0);
  });

  test("hits the company employees endpoint", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: FIXTURE }));
    restore = fetchStub.restore;
    await employeeListHandler({ ...auth })(ctx);
    expect(fetchStub.calls[0]?.url).toContain("/v1/companies/co-1/employees");
  });

  test("an invalid --status short-circuits to a validation error without calling the API", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: FIXTURE }));
    restore = fetchStub.restore;
    const result = await employeeListHandler({ ...auth, status: "pending" })(ctx);
    expect(result.ok).toBe(false);
    expect(blockedFields(result)).toEqual(["status"]);
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe("employeeListHandler pagination", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ uuid: `e${i}`, onboarding_status: "onboarding_completed" }));

  test("default returns first 100 and an opaque next, no summary", async () => {
    restore = stubGlobalFetch(pagedRouter(many(250))).restore;
    const result = await employeeListHandler({ ...auth })(ctx);
    if (!result.ok) throw new Error("expected ok");
    const data = result.data as unknown as EmployeeListData;
    expect(data.employees).toHaveLength(100);
    expect(data.summary).toBeUndefined();
    expect(result.next).toBeDefined();
  });

  test("--all walks every page, includes summary, no next", async () => {
    restore = stubGlobalFetch(pagedRouter(many(250))).restore;
    const result = await employeeListHandler({ ...auth, all: true, status: "all" })(ctx);
    if (!result.ok) throw new Error("expected ok");
    const data = result.data as unknown as EmployeeListData;
    expect(data.employees).toHaveLength(250);
    expect(data.summary?.total).toBe(250);
    expect(result.next).toBeUndefined();
  });

  test("--limit caps total and emits no next", async () => {
    restore = stubGlobalFetch(pagedRouter(many(250))).restore;
    const result = await employeeListHandler({ ...auth, limit: "50", status: "all" })(ctx);
    if (!result.ok) throw new Error("expected ok");
    const data = result.data as unknown as EmployeeListData;
    expect(data.employees).toHaveLength(50);
    expect(result.next).toBeUndefined();
  });

  test("--cursor with --all is rejected (exit 7)", async () => {
    const result = await employeeListHandler({ ...auth, cursor: "x", all: true })(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(7);
  });

  test("sends page and per query params", async () => {
    const fetchStub = stubGlobalFetch(pagedRouter(many(40)));
    restore = fetchStub.restore;
    await employeeListHandler({ ...auth })(ctx);
    expect(fetchStub.calls[0]?.url).toContain("page=1");
    expect(fetchStub.calls[0]?.url).toContain("per=100");
  });
});

describe("employeeAddressesHandler", () => {
  test("combines work and home addresses under stable keys", async () => {
    const fetchStub = routeFetch([
      { match: "/work_addresses", status: 200, body: [{ uuid: "wa-1", street_1: "1 Main" }] },
      { match: "/home_addresses", status: 200, body: [{ uuid: "ha-1", street_1: "2 Elm" }] },
    ]);
    restore = fetchStub.restore;
    const d = okData(await employeeAddressesHandler("emp-1", {})(ctx));
    expect(d.work_addresses).toEqual([{ uuid: "wa-1", street_1: "1 Main" }]);
    expect(d.home_addresses).toEqual([{ uuid: "ha-1", street_1: "2 Elm" }]);
  });

  test("hits both employee address endpoints", async () => {
    const fetchStub = routeFetch([
      { match: "/work_addresses", status: 200, body: [] },
      { match: "/home_addresses", status: 200, body: [] },
    ]);
    restore = fetchStub.restore;
    await employeeAddressesHandler("emp-1", {})(ctx);
    const urls = fetchStub.calls.map((c) => c.url);
    expect(urls.some((u) => u.includes("/v1/employees/emp-1/work_addresses"))).toBe(true);
    expect(urls.some((u) => u.includes("/v1/employees/emp-1/home_addresses"))).toBe(true);
  });

  test("a home-address failure fails the whole command", async () => {
    const fetchStub = routeFetch([
      { match: "/work_addresses", status: 200, body: [] },
      { match: "/home_addresses", status: 404, body: { error: "not found" } },
    ]);
    restore = fetchStub.restore;
    const result = await employeeAddressesHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
  });

  test("a work-address failure short-circuits before fetching home", async () => {
    const fetchStub = routeFetch([
      { match: "/work_addresses", status: 404, body: { error: "not found" } },
      { match: "/home_addresses", status: 200, body: [] },
    ]);
    restore = fetchStub.restore;
    const result = await employeeAddressesHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]?.url).toContain("/work_addresses");
  });
});

describe("single address gets", () => {
  test("work-address hits /v1/work_addresses/{uuid} and returns the body verbatim", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: { uuid: "wa-1", street_1: "1 Main" } }));
    restore = fetchStub.restore;
    const d = okData(await workAddressHandler("wa-1", {})(ctx));
    expect(d).toEqual({ uuid: "wa-1", street_1: "1 Main" });
    expect(fetchStub.calls[0]?.url).toContain("/v1/work_addresses/wa-1");
  });

  test("home-address hits /v1/home_addresses/{uuid} and returns the body verbatim", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: { uuid: "ha-1", street_1: "2 Elm" } }));
    restore = fetchStub.restore;
    const d = okData(await homeAddressHandler("ha-1", {})(ctx));
    expect(d).toEqual({ uuid: "ha-1", street_1: "2 Elm" });
    expect(fetchStub.calls[0]?.url).toContain("/v1/home_addresses/ha-1");
  });
});
