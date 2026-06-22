import { describe, expect, test } from "bun:test";
import { ExitCode } from "../lib/exit-codes.ts";
import { TEST_CONTEXT as ctx, okData } from "../lib/test-support.ts";
import {
  bucketEmployees,
  buildEmployeeList,
  employeeDeleteHandler,
  jobDeleteHandler,
  parseStatus,
} from "./employee.ts";

describe("parseStatus", () => {
  test("undefined defaults to active", () => {
    expect(parseStatus(undefined)).toEqual({ ok: true, status: "active" });
  });

  test("accepts each valid status", () => {
    expect(parseStatus("active")).toEqual({ ok: true, status: "active" });
    expect(parseStatus("onboarding")).toEqual({ ok: true, status: "onboarding" });
    expect(parseStatus("terminated")).toEqual({ ok: true, status: "terminated" });
    expect(parseStatus("all")).toEqual({ ok: true, status: "all" });
  });

  test("rejects an unknown value with the allowed list in the reason", () => {
    const result = parseStatus("pending");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("active");
      expect(result.reason).toContain("pending");
    }
  });
});

// Mirrors the AINT-597 sandbox distribution: 16 active, 63 onboarding, 6 terminated = 85 total.
const FIXTURE = [
  ...Array.from({ length: 16 }, (_, i) => ({ uuid: `a${i}`, onboarding_status: "onboarding_completed" })),
  ...Array.from({ length: 51 }, (_, i) => ({ uuid: `b${i}`, onboarding_status: "admin_onboarding_incomplete" })),
  ...Array.from({ length: 9 }, (_, i) => ({ uuid: `c${i}`, onboarding_status: "self_onboarding_pending_invite" })),
  ...Array.from({ length: 3 }, (_, i) => ({ uuid: `d${i}`, onboarding_status: "self_onboarding_invited_overdue" })),
  ...Array.from({ length: 6 }, (_, i) => ({
    uuid: `t${i}`,
    terminated: true,
    onboarding_status: "onboarding_completed",
  })),
];

describe("bucketEmployees", () => {
  test("partitions into active / onboarding / terminated matching the ticket counts", () => {
    const buckets = bucketEmployees(FIXTURE);
    expect(buckets.active).toHaveLength(16);
    expect(buckets.onboarding).toHaveLength(63);
    expect(buckets.terminated).toHaveLength(6);
  });

  test("terminated wins even when onboarding is complete", () => {
    const buckets = bucketEmployees([{ terminated: true, onboarding_status: "onboarding_completed" }]);
    expect(buckets.terminated).toHaveLength(1);
    expect(buckets.active).toHaveLength(0);
  });

  test("an unknown onboarding_status on a non-terminated employee falls into onboarding", () => {
    const buckets = bucketEmployees([{ onboarding_status: "some_new_status" }]);
    expect(buckets.onboarding).toHaveLength(1);
  });
});

describe("buildEmployeeList", () => {
  test("summary always carries the full breakdown regardless of filter", () => {
    const { summary } = buildEmployeeList(FIXTURE, "active");
    expect(summary).toEqual({ total: 85, active: 16, onboarding: 63, terminated: 6, filter_applied: "active" });
  });

  test("active filter returns only the 16 active employees", () => {
    const { employees } = buildEmployeeList(FIXTURE, "active");
    expect(employees).toHaveLength(16);
  });

  test("onboarding filter returns only the 63 onboarding employees", () => {
    const { employees } = buildEmployeeList(FIXTURE, "onboarding");
    expect(employees).toHaveLength(63);
  });

  test("terminated filter returns only the 6 terminated employees", () => {
    const { employees } = buildEmployeeList(FIXTURE, "terminated");
    expect(employees).toHaveLength(6);
  });

  test("all filter returns every record in original order", () => {
    const { employees, summary } = buildEmployeeList(FIXTURE, "all");
    expect(employees).toHaveLength(85);
    expect(summary.filter_applied).toBe("all");
    expect((employees[0] as { uuid: string }).uuid).toBe("a0");
  });

  test("a non-array body yields zero counts and an empty list", () => {
    const { summary, employees } = buildEmployeeList(null, "active");
    expect(summary).toEqual({ total: 0, active: 0, onboarding: 0, terminated: 0, filter_applied: "active" });
    expect(employees).toHaveLength(0);
  });
});

describe("employeeDeleteHandler", () => {
  test("missing employee_uuid refuses with a structured blocked_on (no network)", async () => {
    const result = await employeeDeleteHandler(undefined, {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.blocked_on?.[0]?.field).toBe("employee_uuid");
  });

  test("--dry-run emits the DELETE shape without sending", async () => {
    const d = okData(await employeeDeleteHandler("emp-1", { dryRun: true })(ctx));
    expect(d).toEqual({ method: "DELETE", path: "/v1/employees/emp-1" });
  });

  test("--example returns a canned envelope without requiring a uuid", async () => {
    const d = okData(await employeeDeleteHandler(undefined, { example: true })(ctx));
    expect(d.method).toBe("DELETE");
    expect(d.path).toContain("/v1/employees/");
  });
});

describe("jobDeleteHandler", () => {
  test("missing job_uuid refuses with a structured blocked_on", async () => {
    const result = await jobDeleteHandler(undefined, {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Validation);
    expect(result.error.blocked_on?.[0]?.field).toBe("job_uuid");
  });

  test("--dry-run emits the DELETE shape without sending", async () => {
    const d = okData(await jobDeleteHandler("job-1", { dryRun: true })(ctx));
    expect(d).toEqual({ method: "DELETE", path: "/v1/jobs/job-1" });
  });

  test("--example returns a canned envelope without requiring a uuid", async () => {
    const d = okData(await jobDeleteHandler(undefined, { example: true })(ctx));
    expect(d.method).toBe("DELETE");
    expect(d.path).toContain("/v1/jobs/");
  });
});
