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
  employeeUpdateHandler,
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

describe("employeeUpdateHandler", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  const activeAddress = { uuid: "wa-1", version: "v1", active: true, state: "PA" };
  const mdLocation = { uuid: "loc-md", state: "MD", active: true };

  function happyPathRoutes(overrides: Partial<Record<string, { status: number; body?: unknown }>> = {}) {
    return routeFetch([
      {
        match: "/v1/employees/emp-1/work_addresses",
        status: 200,
        body: [activeAddress],
        ...overrides.addresses,
      },
      { match: "/v1/companies/co-1/locations", status: 200, body: [mdLocation], ...overrides.locations },
      {
        match: "/v1/work_addresses/wa-1",
        status: 200,
        body: { ...activeAddress, state: "MD", location_uuid: "loc-md", version: "v2" },
        ...overrides.put,
      },
      {
        match: "/v1/companies/co-1/tax_requirements/MD",
        status: 200,
        body: {
          state: "MD",
          requirement_sets: [
            { key: "registrations", requirements: [{ key: "withholding_number", editable: true, value: null }] },
          ],
        },
        ...overrides.tax,
      },
    ]);
  }

  test("--example prints a canned PUT payload without calling the API", async () => {
    const s = stubGlobalFetch(() => ({ status: 500 }));
    restore = s.restore;
    const d = okData(await employeeUpdateHandler("emp-1", { ...auth, example: true })(ctx));
    expect(d.method).toBe("PUT");
    expect(d.path).toBe("/v1/work_addresses/{work_address_uuid}");
    expect(s.calls).toHaveLength(0);
  });

  test("a missing --work-state is refused pre-flight with a blocked_on list, no API call", async () => {
    const s = stubGlobalFetch(() => ({ status: 500 }));
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toEqual(["work-state"]);
    expect(s.calls).toHaveLength(0);
  });

  test("an invalid --work-state format is refused pre-flight, no API call", async () => {
    const s = stubGlobalFetch(() => ({ status: 500 }));
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth, workState: "Maryland" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toEqual(["work-state"]);
    expect(s.calls).toHaveLength(0);
  });

  test("an invalid --effective-date is refused pre-flight, no API call", async () => {
    const s = stubGlobalFetch(() => ({ status: 500 }));
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", {
      ...auth,
      workState: "MD",
      effectiveDate: "08-01-2026",
    })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(blockedFields(result)).toEqual(["effective-date"]);
    expect(s.calls).toHaveLength(0);
  });

  test("an agent-mode update without --confirm is blocked and sends nothing", async () => {
    const s = stubGlobalFetch(() => ({ status: 500 }));
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth, workState: "MD" })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("confirmation_required");
    expect(s.calls).toHaveLength(0);
  });

  test("no active work address on file returns a domain error", async () => {
    const s = routeFetch([
      { match: "/v1/employees/emp-1/work_addresses", status: 200, body: [{ ...activeAddress, active: false }] },
    ]);
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("no_active_work_address");
  });

  test("already working from the target state is a no-op and never queries locations or tax requirements", async () => {
    const s = routeFetch([
      { match: "/v1/employees/emp-1/work_addresses", status: 200, body: [{ ...activeAddress, state: "PA" }] },
    ]);
    restore = s.restore;
    const d = okData(await employeeUpdateHandler("emp-1", { ...auth, workState: "PA", confirm: true })(ctx));
    expect(d.changed).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  test("--dry-run against an already-matching state still returns the no-op result, not a fake preview", async () => {
    const s = routeFetch([
      { match: "/v1/employees/emp-1/work_addresses", status: 200, body: [{ ...activeAddress, state: "PA" }] },
    ]);
    restore = s.restore;
    const d = okData(await employeeUpdateHandler("emp-1", { ...auth, workState: "PA", dryRun: true })(ctx));
    expect(d.changed).toBe(false);
    expect(d.method).toBeUndefined();
    expect(s.calls).toHaveLength(1);
  });

  test("a lowercase --work-state matching the current (uppercase) state is still a no-op", async () => {
    const s = routeFetch([
      { match: "/v1/employees/emp-1/work_addresses", status: 200, body: [{ ...activeAddress, state: "PA" }] },
    ]);
    restore = s.restore;
    const d = okData(await employeeUpdateHandler("emp-1", { ...auth, workState: "pa", confirm: true })(ctx));
    expect(d.changed).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  test("no active company location in the target state returns a domain error and never PUTs", async () => {
    const s = routeFetch([
      { match: "/v1/employees/emp-1/work_addresses", status: 200, body: [activeAddress] },
      { match: "/v1/companies/co-1/locations", status: 200, body: [{ uuid: "loc-ca", state: "CA", active: true }] },
    ]);
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("no_company_location_for_state");
    expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("dry-run resolves the location and builds the PUT body without sending it or fetching the tax nudge", async () => {
    const s = happyPathRoutes();
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", dryRun: true })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data).toEqual({
      method: "PUT",
      path: "/v1/work_addresses/wa-1",
      body: { version: "v1", location_uuid: "loc-md" },
    });
    expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(s.calls.some((c) => c.url.includes("tax_requirements"))).toBe(false);
  });

  test("--effective-date is included in the dry-run body when given", async () => {
    const s = happyPathRoutes();
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", {
      ...auth,
      workState: "MD",
      effectiveDate: "2026-08-01",
      dryRun: true,
    })(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect((result.data as { body: Record<string, unknown> }).body).toMatchObject({ effective_date: "2026-08-01" });
  });

  test("--confirm PUTs the resolved work address and includes the compliance nudge", async () => {
    const s = happyPathRoutes();
    restore = s.restore;
    const d = okData(await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", confirm: true })(ctx));
    expect(d.changed).toBe(true);
    expect((d.work_address as Record<string, unknown>).state).toBe("MD");
    expect(d.compliance).toMatchObject({
      state: "MD",
      outstanding: [{ key: "withholding_number", label: undefined, payroll_blocking: false }],
    });
    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/v1/work_addresses/wa-1");
    expect(put?.body).toEqual({ version: "v1", location_uuid: "loc-md" });
  });

  test("picks the matching location out of several, not just the first in the list", async () => {
    const s = happyPathRoutes({
      locations: {
        status: 200,
        body: [
          { uuid: "loc-ca", state: "CA", active: true },
          { uuid: "loc-md", state: "MD", active: true },
          { uuid: "loc-ny", state: "NY", active: true },
        ],
      },
    });
    restore = s.restore;
    await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", confirm: true })(ctx);
    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ version: "v1", location_uuid: "loc-md" });
  });

  test("a lowercase --work-state resolves to the matching location and the uppercased nudge path", async () => {
    const s = happyPathRoutes();
    restore = s.restore;
    await employeeUpdateHandler("emp-1", { ...auth, workState: "md", confirm: true })(ctx);
    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ version: "v1", location_uuid: "loc-md" });
    expect(s.calls.some((c) => c.url.includes("tax_requirements/MD"))).toBe(true);
  });

  test("matches a location whose stored state is lowercase", async () => {
    const s = happyPathRoutes({ locations: { status: 200, body: [{ uuid: "loc-md", state: "md", active: true }] } });
    restore = s.restore;
    await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", confirm: true })(ctx);
    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ version: "v1", location_uuid: "loc-md" });
  });

  test("a non-array work_addresses body is rejected as malformed, no locations/PUT/nudge calls", async () => {
    const s = routeFetch([{ match: "/v1/employees/emp-1/work_addresses", status: 200, body: { not: "an array" } }]);
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("malformed_response");
    expect(s.calls).toHaveLength(1);
  });

  test("a rejected PUT (e.g. a stale version) fails the command instead of reporting a phantom success", async () => {
    const s = happyPathRoutes({ put: { status: 422, body: { errors: [{ message: "stale version" }] } } });
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(s.calls.some((c) => c.url.includes("tax_requirements"))).toBe(false);
  });

  test("a failed tax-requirements nudge fetch fails the command as a partial failure, not a phantom success", async () => {
    const s = happyPathRoutes({ tax: { status: 404, body: { errors: [{ message: "not found" }] } } });
    restore = s.restore;
    const result = await employeeUpdateHandler("emp-1", { ...auth, workState: "MD", confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.ApiClient);
    expect(result.error.code).toBe("compliance_nudge_fetch_failed");
    const details = result.error.details as Record<string, unknown>;
    expect(details.completed).toEqual(["work_address"]);
    expect((details.work_address as Record<string, unknown>).state).toBe("MD");
    expect((details.failed as Record<string, unknown>).domain).toBe("tax_requirements");
  });

  test("encodes an employee uuid with URL-significant characters into a single path segment", async () => {
    const s = routeFetch([{ match: "/v1/employees/a%2Fb%3Fc%23d/work_addresses", status: 200, body: [activeAddress] }]);
    restore = s.restore;
    await employeeUpdateHandler("a/b?c#d", { ...auth, workState: "PA", confirm: true })(ctx);
    expect(s.calls[0]?.url).toContain("/v1/employees/a%2Fb%3Fc%23d/work_addresses");
    expect(s.calls[0]?.url).not.toContain("a/b?c");
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

  // A not_found 404 is either "nothing scheduled to cancel" or a bad uuid. The API's own message
  // (surfaced generically via writeHumanError's `reason:` line) tells those apart; the hint only adds
  // the safety note that a bad uuid also 404s, leaving a real termination scheduled. The raw body
  // stays in details untouched, so the message is preserved verbatim for the reason line / agent mode.
  test("a 404 not_found attaches the static safety hint and leaves the API message in details", async () => {
    const body = { errors: [{ category: "not_found", message: "The employee has not been terminated." }] };
    const s = stubGlobalFetch(() => ({ status: 404, body }));
    restore = s.restore;
    const result = await employeeTerminateCancelHandler("emp-1", { ...auth, confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.hint).toContain("a real termination may still be scheduled");
    // The hint no longer embeds the API message - that reaches humans via the reason line.
    expect(result.error.hint).not.toContain("The employee has not been terminated.");
    expect(result.error.details).toEqual(body);
  });

  test("a non-not_found failure is left untouched (no hint added)", async () => {
    const s = stubGlobalFetch(() => ({
      status: 422,
      body: { errors: [{ category: "invalid_attributes", message: "nope" }] },
    }));
    restore = s.restore;
    const result = await employeeTerminateCancelHandler("emp-1", { ...auth, confirm: true })(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.hint).toBeUndefined();
  });
});
