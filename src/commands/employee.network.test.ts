import { afterEach, describe, expect, test } from "bun:test";
import {
  type EmployeeListData,
  type EmployeeListSummary,
  employeeHistoryHandler,
  employeeListHandler,
  employeeRehireHandler,
  employeeTerminationsHandler,
} from "./employee.ts";
import {
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  blockedFields,
  okData,
  pagedRouter,
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

describe("employee lifecycle reads", () => {
  test("history hits /v1/employees/{uuid}/employment_history and returns the body verbatim", async () => {
    const body = { employee_uuid: "emp-1", terminations: [{ uuid: "term-1" }], rehires: [] };
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = fetchStub.restore;
    const d = okData(await employeeHistoryHandler("emp-1", {})(ctx));
    expect(d).toEqual(body);
    expect(fetchStub.calls[0]?.url).toContain("/v1/employees/emp-1/employment_history");
  });

  test("terminations hits /v1/employees/{uuid}/terminations and returns the list verbatim", async () => {
    const body = [{ uuid: "term-1", effective_date: "2026-01-31" }];
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = fetchStub.restore;
    const result = await employeeTerminationsHandler("emp-1", {})(ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual(body);
    expect(fetchStub.calls[0]?.url).toContain("/v1/employees/emp-1/terminations");
  });

  test("rehire hits /v1/employees/{uuid}/rehire and returns the body verbatim", async () => {
    const body = { uuid: "rehire-1", effective_date: "2026-06-01" };
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = fetchStub.restore;
    const d = okData(await employeeRehireHandler("emp-1", {})(ctx));
    expect(d).toEqual(body);
    expect(fetchStub.calls[0]?.url).toContain("/v1/employees/emp-1/rehire");
  });

  test("terminations returns an empty list for a never-terminated employee", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restore = fetchStub.restore;
    const result = await employeeTerminationsHandler("emp-1", {})(ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual([]);
  });

  test.each([
    ["history", employeeHistoryHandler],
    ["terminations", employeeTerminationsHandler],
    ["rehire", employeeRehireHandler],
  ])("an API error fails the command (%s)", async (_name, handler) => {
    restore = stubGlobalFetch(() => ({ status: 404, body: { error: "not found" } })).restore;
    const result = await handler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
  });
});
