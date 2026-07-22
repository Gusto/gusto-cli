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

  test("encodes a uuid with URL-significant characters into a single segment", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = stub.restore;
    await jobShowHandler("a/b?c#d", {})(ctx);
    expect(stub.calls[0]?.url).toContain("/v1/jobs/a%2Fb%3Fc%23d");
    expect(stub.calls[0]?.url).not.toContain("a/b?c");
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

  test("encodes a uuid with URL-significant characters into a single segment", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: [] }));
    restore = stub.restore;
    await jobCompensationsHandler("a/b?c#d", {})(ctx);
    expect(stub.calls[0]?.url).toContain("/v1/jobs/a%2Fb%3Fc%23d/compensations");
    expect(stub.calls[0]?.url).not.toContain("a/b?c");
  });

  test("a non-array 2xx body is rejected as malformed", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { not: "an array" } }));
    restore = stub.restore;
    const result = await jobCompensationsHandler("job-1", {})(ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("malformed_response");
  });
});
