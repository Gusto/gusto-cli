import { afterEach, describe, expect, test } from "bun:test";
import { jobCompensationsHandler, jobShowHandler } from "./job.ts";
import { TEST_CONTEXT as ctx, okData, stubGlobalFetch } from "../lib/test-support.ts";

let restore: () => void = () => {};
afterEach(() => restore());

describe("jobShowHandler", () => {
  test("hits /v1/jobs/{uuid} and passes the body through", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { uuid: "job-1", title: "Engineer" } }));
    restore = stub.restore;
    const d = okData(await jobShowHandler("job-1", {})(ctx));
    expect(stub.calls[0]?.url).toContain("/v1/jobs/job-1");
    expect(d).toEqual({ uuid: "job-1", title: "Engineer" });
  });
});

describe("jobCompensationsHandler", () => {
  test("hits /v1/jobs/{uuid}/compensations and passes the array through", async () => {
    const body = [{ uuid: "comp-1" }, { uuid: "comp-2" }];
    const stub = stubGlobalFetch(() => ({ status: 200, body }));
    restore = stub.restore;
    const result = await jobCompensationsHandler("job-1", {})(ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(stub.calls[0]?.url).toContain("/v1/jobs/job-1/compensations");
    expect(result.data).toEqual(body);
  });
});
