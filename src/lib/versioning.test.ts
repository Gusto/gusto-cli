import { describe, expect, test } from "bun:test";
import type { ApiClient } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";
import { clarifyVersionConflict, clarifyVersionReadFailure, getAndInjectVersion, withVersion } from "./versioning.ts";

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

describe("clarifyVersionReadFailure", () => {
  const authFailure: CommandResult = {
    ok: false,
    exitCode: ExitCode.Auth,
    error: { code: "insufficient_scope", message: "missing scope", request_id: "req-1" },
  };

  test("prefixes the message but keeps the code, exit, and extras", () => {
    const result = clarifyVersionReadFailure(authFailure, "/v1/thing");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Auth); // an auth problem on the GET is still an auth problem
    expect(result.error.code).toBe("insufficient_scope");
    expect(result.error.request_id).toBe("req-1");
    expect(result.error.message).toBe(
      "reading the current version from GET /v1/thing failed, so nothing was written: missing scope",
    );
  });

  test("passes a success through untouched", () => {
    const ok: CommandResult = { ok: true, data: { a: 1 } };
    expect(clarifyVersionReadFailure(ok, "/v1/thing")).toBe(ok);
  });
});

describe("clarifyVersionConflict", () => {
  const rejected = (details: unknown): CommandResult => ({
    ok: false,
    exitCode: ExitCode.ApiClient,
    error: { code: "api_client_error", message: "PUT /v1/thing -> 409", details, request_id: "req-1" },
  });

  test("re-codes the API's invalid_resource_version rejection to a Blocked version_conflict", () => {
    const details = { errors: [{ category: "invalid_resource_version", message: "stale" }] };
    const result = clarifyVersionConflict(rejected(details));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("version_conflict");
    expect(result.error.message).toContain("Re-run to pick up the current version");
    expect(result.error.details).toEqual(details); // the raw body survives for debugging
    expect(result.error.request_id).toBe("req-1");
  });

  test("leaves a rejection with a different category alone", () => {
    const original = rejected({ errors: [{ category: "invalid_operation" }] });
    expect(clarifyVersionConflict(original)).toBe(original);
  });

  test("leaves a rejection with no errors array alone", () => {
    const original = rejected({ message: "nope" });
    expect(clarifyVersionConflict(original)).toBe(original);
  });

  test("leaves a non-ApiClient failure alone (a network blip is not a conflict)", () => {
    const original: CommandResult = {
      ok: false,
      exitCode: ExitCode.Network,
      error: { code: "network_error", message: "connection reset" },
    };
    expect(clarifyVersionConflict(original)).toBe(original);
  });

  test("passes a success through untouched", () => {
    const ok: CommandResult = { ok: true, data: { a: 1 } };
    expect(clarifyVersionConflict(ok)).toBe(ok);
  });
});
