import { describe, expect, test } from "bun:test";
import type { ApiClient } from "./api-client.ts";
import { getAndInjectVersion, readString, withVersion } from "./versioning.ts";

/** Minimal stub: a `get` that returns a fixed body and records the paths it was called with. */
function stubClient(getBody: unknown): { client: Pick<ApiClient, "get">; paths: string[] } {
  const paths: string[] = [];
  const client = {
    get: async (path: string) => {
      paths.push(path);
      return { status: 200, body: getBody };
    },
  } as unknown as Pick<ApiClient, "get">;
  return { client, paths };
}

describe("readString", () => {
  test("returns a non-empty string field", () => {
    expect(readString({ v: "x" }, "v")).toBe("x");
  });
  test("undefined for an empty string", () => {
    expect(readString({ v: "" }, "v")).toBeUndefined();
  });
  test("undefined for a non-string value", () => {
    expect(readString({ v: 1 }, "v")).toBeUndefined();
  });
  test("undefined for a non-object body", () => {
    expect(readString(null, "v")).toBeUndefined();
    expect(readString("nope", "v")).toBeUndefined();
  });
});

describe("withVersion", () => {
  test("injects the version when the body has none", () => {
    expect(withVersion({ a: 1 }, "v1")).toEqual({ a: 1, version: "v1" });
  });

  test("a valid caller-supplied version wins (body returned unchanged)", () => {
    const body = { version: "caller" };
    expect(withVersion(body, "v1")).toBe(body);
  });

  test("returns the body unchanged when there is no version to inject", () => {
    const body = { a: 1 };
    expect(withVersion(body, undefined)).toBe(body);
  });

  test("an empty/invalid caller version does not clobber the injected one", () => {
    // Regression: the spread order must keep the injected version (not the empty "").
    expect(withVersion({ version: "" }, "v1")).toEqual({ version: "v1" });
  });
});

describe("getAndInjectVersion", () => {
  test("GETs the current resource and injects its version", async () => {
    const { client, paths } = stubClient({ version: "v-current" });
    const result = await getAndInjectVersion(client, "/v1/thing", { a: 1 });
    expect(result).toEqual({ ok: true, body: { a: 1, version: "v-current" } });
    expect(paths).toEqual(["/v1/thing"]);
  });

  test("a caller-supplied version wins and skips the GET", async () => {
    const { client, paths } = stubClient({ version: "v-current" });
    const result = await getAndInjectVersion(client, "/v1/thing", { a: 1, version: "caller" });
    expect(result).toEqual({ ok: true, body: { a: 1, version: "caller" } });
    expect(paths).toEqual([]);
  });

  test("an empty caller version still fires the GET and the fetched version wins", async () => {
    const { client, paths } = stubClient({ version: "v-current" });
    const result = await getAndInjectVersion(client, "/v1/thing", { version: "" });
    expect(result).toEqual({ ok: true, body: { version: "v-current" } });
    expect(paths).toEqual(["/v1/thing"]);
  });

  test("reports version_unresolved when the GET response has no version", async () => {
    const { client } = stubClient({ no_version_here: true });
    const result = await getAndInjectVersion(client, "/v1/thing", { a: 1 });
    expect(result).toEqual({ ok: false, reason: "version_unresolved" });
  });
});
