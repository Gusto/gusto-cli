import { afterEach, describe, expect, test } from "bun:test";
import { compensationShowHandler } from "./compensation.ts";
import { TEST_CONTEXT as ctx, okData, stubGlobalFetch } from "../lib/test-support.ts";

let restore: () => void = () => {};
afterEach(() => restore());

describe("compensationShowHandler", () => {
  test("hits /v1/compensations/{uuid} and passes the body through", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: { uuid: "comp-1", rate: "50.00" } }));
    restore = stub.restore;
    const d = okData(await compensationShowHandler("comp-1", {})(ctx));
    expect(stub.calls[0]?.url).toContain("/v1/compensations/comp-1");
    expect(d).toEqual({ uuid: "comp-1", rate: "50.00" });
  });

  test("encodes a uuid with URL-significant characters into a single segment", async () => {
    const stub = stubGlobalFetch(() => ({ status: 200, body: {} }));
    restore = stub.restore;
    await compensationShowHandler("a/b?c#d", {})(ctx);
    expect(stub.calls[0]?.url).toContain("/v1/compensations/a%2Fb%3Fc%23d");
    expect(stub.calls[0]?.url).not.toContain("a/b?c");
  });
});
