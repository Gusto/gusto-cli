import { afterEach, describe, expect, test } from "bun:test";
import {
  type EmployeeListData,
  type EmployeeListSummary,
  employeeDeleteHandler,
  employeeListHandler,
  jobDeleteHandler,
} from "./employee.ts";
import {
  type MockResponse,
  type RecordedCall,
  TEST_AUTH as auth,
  TEST_CONTEXT as ctx,
  blockedFields,
  okData,
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
    expect(d.summary.total).toBe(0);
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

function stubSeq(responses: MockResponse[]): RecordedCall[] {
  const s = stubGlobalFetch(responses);
  restore = s.restore;
  return s.calls;
}

describe("employeeDeleteHandler (network)", () => {
  test("204 success → { deleted: true, employee_uuid }", async () => {
    const calls = stubSeq([{ status: 204, body: "" }]);
    const d = okData(await employeeDeleteHandler("emp-1", {})(ctx));
    expect(d).toEqual({ deleted: true, employee_uuid: "emp-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/v1/employees/emp-1");
  });

  test("422 'Cannot delete onboarded employee' propagates as a structured error", async () => {
    stubSeq([{ status: 422, body: { errors: [{ error_key: "base", message: "Cannot delete onboarded employee" }] } }]);
    const result = await employeeDeleteHandler("emp-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.message).toContain("422");
    expect(JSON.stringify(result.error.details)).toContain("Cannot delete onboarded employee");
  });
});

describe("jobDeleteHandler (network)", () => {
  test("DELETE 204 then GET 404 → action 'destroyed'", async () => {
    const calls = stubSeq([
      { status: 204, body: "" },
      { status: 404, body: { errors: [{ message: "not found" }] } },
    ]);
    const d = okData(await jobDeleteHandler("job-1", {})(ctx));
    expect(d).toEqual({ action: "destroyed", job_uuid: "job-1" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.url).toContain("/v1/jobs/job-1");
  });

  test("DELETE 204 then GET 200 with active:false → action 'deactivated'", async () => {
    const calls = stubSeq([
      { status: 204, body: "" },
      { status: 200, body: { uuid: "job-1", active: false } },
    ]);
    const d = okData(await jobDeleteHandler("job-1", {})(ctx));
    expect(d).toEqual({ action: "deactivated", job_uuid: "job-1" });
    expect(calls).toHaveLength(2);
  });

  test("DELETE 422 'must have at least one active job' propagates", async () => {
    const calls = stubSeq([{ status: 422, body: { errors: [{ message: "must have at least one active job" }] } }]);
    const result = await jobDeleteHandler("job-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(JSON.stringify(result.error.details)).toContain("at least one active job");
    // No follow-up GET when the DELETE itself failed.
    expect(calls).toHaveLength(1);
  });
});
