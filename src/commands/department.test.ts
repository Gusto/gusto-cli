import { afterEach, describe, expect, test } from "bun:test";
import { departmentListHandler, departmentShowHandler } from "./department.ts";
import { TEST_AUTH as auth, TEST_CONTEXT as ctx, okData, stubGlobalFetch } from "../lib/test-support.ts";

let restore: () => void = () => {};
afterEach(() => restore());

describe("departmentListHandler", () => {
  test("hits /v1/companies/{uuid}/departments and passes the array through", async () => {
    const body = [
      { uuid: "dept-1", title: "Engineering" },
      { uuid: "dept-2", title: "Sales" },
    ];
    const stub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = stub.restore;
    const result = await departmentListHandler({ ...auth })(ctx);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(stub.calls[0]?.url).toContain("/v1/companies/co-1/departments");
    expect(result.data).toEqual(body);
  });

  test("an empty company yields an empty list", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restore = stub.restore;
    const result = await departmentListHandler({ ...auth })(ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual([]);
  });
});

describe("departmentShowHandler", () => {
  test("hits /v1/departments/{uuid} and passes the body through", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { uuid: "dept-1", title: "Engineering" } }));
    restore = stub.restore;
    const d = okData(await departmentShowHandler("dept-1", {})(ctx));
    expect(stub.calls[0]?.url).toContain("/v1/departments/dept-1");
    expect(d).toEqual({ uuid: "dept-1", title: "Engineering" });
  });

  test("percent-encodes the UUID so '../' can't retarget the GET within the same origin", async () => {
    const stub = stubGlobalFetch(() => ({ status: 404 }));
    restore = stub.restore;
    await departmentShowHandler("../companies/co-1/payroll_reversals", {})(ctx);
    expect(stub.calls[0]?.url).toContain("/v1/departments/..%2Fcompanies%2Fco-1%2Fpayroll_reversals");
    expect(stub.calls[0]?.url).not.toContain("/v1/companies/co-1/payroll_reversals");
  });
});
