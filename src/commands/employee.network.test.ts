import { afterEach, describe, expect, test } from "bun:test";
import {
  type EmployeeListData,
  type EmployeeListSummary,
  employeeAddressesHandler,
  employeeHistoryHandler,
  employeeJobsHandler,
  employeeListHandler,
  employeeRehireHandler,
  employeeTerminateCancelHandler,
  employeeTerminateHandler,
  employeeTerminationsHandler,
  homeAddressHandler,
  workAddressHandler,
} from "./employee.ts";
import { ExitCode } from "../lib/exit-codes.ts";
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

  test("a home-address failure fails the whole command with a home-scoped message", async () => {
    const fetchStub = routeFetch([
      { match: "/work_addresses", status: 200, body: [] },
      { match: "/home_addresses", status: 404, body: { error: "not found" } },
    ]);
    restore = fetchStub.restore;
    const result = await employeeAddressesHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("home addresses for employee emp-1");
  });

  test("a work-address failure wins and names the work side, even though both GETs fire", async () => {
    const fetchStub = routeFetch([
      { match: "/work_addresses", status: 404, body: { error: "not found" } },
      { match: "/home_addresses", status: 200, body: [] },
    ]);
    restore = fetchStub.restore;
    const result = await employeeAddressesHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("work addresses for employee emp-1");
    // Runs in parallel now, so both endpoints are hit (no short-circuit).
    expect(fetchStub.calls).toHaveLength(2);
  });

  test("a non-array work_addresses body is rejected as malformed", async () => {
    const fetchStub = routeFetch([
      { match: "/work_addresses", status: 200, body: { not: "an array" } },
      { match: "/home_addresses", status: 200, body: [] },
    ]);
    restore = fetchStub.restore;
    const result = await employeeAddressesHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("malformed_response");
  });

  test("a non-array home_addresses body is rejected as malformed", async () => {
    const fetchStub = routeFetch([
      { match: "/work_addresses", status: 200, body: [] },
      { match: "/home_addresses", status: 200, body: { not: "an array" } },
    ]);
    restore = fetchStub.restore;
    const result = await employeeAddressesHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("malformed_response");
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

describe("employeeJobsHandler", () => {
  test("hits /v1/employees/{uuid}/jobs and passes the array through", async () => {
    const body = [{ uuid: "job-1", title: "Engineer" }];
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = fetchStub.restore;
    const result = await employeeJobsHandler("emp-1", {})(ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(fetchStub.calls[0]?.url).toContain("/v1/employees/emp-1/jobs");
    expect(result.data).toEqual(body);
  });

  test("encodes a uuid with URL-significant characters into a single segment", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restore = fetchStub.restore;
    await employeeJobsHandler("a/b?c#d", {})(ctx);
    expect(fetchStub.calls[0]?.url).toContain("/v1/employees/a%2Fb%3Fc%23d/jobs");
    expect(fetchStub.calls[0]?.url).not.toContain("a/b?c");
  });

  test("a non-array 2xx body is rejected as malformed", async () => {
    const fetchStub = stubGlobalFetch(() => ({ status: 200, body: { not: "an array" } }));
    restore = fetchStub.restore;
    const result = await employeeJobsHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("malformed_response");
  });
});

describe("employeeTerminateHandler", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  test("--example prints a canned POST payload without calling the API", async () => {
    const s = stubGlobalFetch(() => ({ status: 500 }));
    restore = s.restore;
    const d = okData(await employeeTerminateHandler("emp-1", { ...auth, example: true })(ctx));
    expect(d.method).toBe("POST");
    expect(d.path).toBe("/v1/employees/{employee_id}/terminations");
    expect(d.body).toMatchObject({ run_termination_payroll: false });
    expect((d.body as Record<string, unknown>).effective_date).toBeDefined();
    expect(s.calls).toHaveLength(0);
  });

  test("a missing --effective-date is refused pre-flight with a blocked_on list, no API call", async () => {
    const s = stubGlobalFetch(() => ({ status: 500 }));
    restore = s.restore;
    const result = await employeeTerminateHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toEqual(["effective-date"]);
    expect(s.calls).toHaveLength(0);
  });

  test("a malformed --effective-date is refused pre-flight with a blocked_on list, no API call", async () => {
    const s = stubGlobalFetch(() => ({ status: 500 }));
    restore = s.restore;
    const result = await employeeTerminateHandler("emp-1", { ...auth, effectiveDate: "08-01-2026" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toEqual(["effective-date"]);
    expect(s.calls).toHaveLength(0);
  });

  test("dry-run builds the termination body and hits the employee-scoped path", async () => {
    const result = await employeeTerminateHandler("emp-1", {
      ...auth,
      effectiveDate: "2026-08-01",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({
      method: "POST",
      path: "/v1/employees/emp-1/terminations",
      body: { effective_date: "2026-08-01", run_termination_payroll: false },
    });
  });

  test("--run-termination-payroll flips the off-cycle flag in the body", async () => {
    const result = await employeeTerminateHandler("emp-1", {
      ...auth,
      effectiveDate: "2026-08-01",
      runTerminationPayroll: true,
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as { body: Record<string, unknown> }).body).toMatchObject({
      run_termination_payroll: true,
    });
  });

  test("an agent-mode terminate without --confirm is blocked and sends nothing", async () => {
    const s = stubGlobalFetch(() => ({ status: 201, body: {} }));
    restore = s.restore;
    const result = await employeeTerminateHandler("emp-1", { ...auth, effectiveDate: "2026-08-01" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("confirmation_required");
    expect(s.calls).toHaveLength(0);
  });

  test("--confirm POSTs the termination to the employee endpoint", async () => {
    const s = stubGlobalFetch((u) =>
      u.includes("/v1/employees/emp-1/terminations") ? { status: 201, body: { active: true } } : { status: 404 },
    );
    restore = s.restore;
    const result = await employeeTerminateHandler("emp-1", {
      ...auth,
      effectiveDate: "2026-08-01",
      confirm: true,
    })(ctx);
    expect(result.ok).toBe(true);
    const post = s.calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/v1/employees/emp-1/terminations");
    expect(post?.body).toEqual({ effective_date: "2026-08-01", run_termination_payroll: false });
  });

  test("encodes a uuid with URL-significant characters into a single path segment", async () => {
    const s = stubGlobalFetch(() => ({ status: 201, body: {} }));
    restore = s.restore;
    await employeeTerminateHandler("a/b?c#d", { ...auth, effectiveDate: "2026-08-01", confirm: true })(ctx);
    const post = s.calls.find((c) => c.method === "POST");
    // The raw `/`, `?`, `#` must be percent-encoded so they can't retarget the write.
    expect(post?.url).toContain("/v1/employees/a%2Fb%3Fc%23d/terminations");
    expect(post?.url).not.toContain("a/b?c");
  });
});

describe("employeeTerminateCancelHandler", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  test("dry-run echoes the bodyless DELETE against the employee endpoint", async () => {
    const result = await employeeTerminateCancelHandler("emp-1", { ...auth, dryRun: true })(ctx);
    expect(result).toEqual({
      ok: true,
      data: { method: "DELETE", path: "/v1/employees/emp-1/terminations" },
    });
  });

  test("an agent-mode cancel without --confirm is blocked and sends nothing", async () => {
    const s = stubGlobalFetch(() => ({ status: 204 }));
    restore = s.restore;
    const result = await employeeTerminateCancelHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("confirmation_required");
    expect(s.calls).toHaveLength(0);
  });

  test("--confirm DELETEs the termination and returns the empty response body", async () => {
    const s = stubGlobalFetch((u) =>
      u.includes("/v1/employees/emp-1/terminations") ? { status: 204 } : { status: 404 },
    );
    restore = s.restore;
    const result = await employeeTerminateCancelHandler("emp-1", { ...auth, confirm: true })(ctx);
    expect(result).toEqual({ ok: true, data: null });
    const del = s.calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/v1/employees/emp-1/terminations");
  });
});
