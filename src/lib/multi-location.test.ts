import { describe, expect, test } from "bun:test";
import { type ApiClient, ApiError } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import { findMultiLocationHours, isMultiLocation, multiLocationRefusal } from "./multi-location.ts";

describe("isMultiLocation", () => {
  test("counts only addresses that are strictly active", () => {
    expect(isMultiLocation([{ active: true }, { active: true }])).toBe(true);
    expect(isMultiLocation([{ active: true }, { active: false }, { active: "true" }])).toBe(false);
    expect(isMultiLocation([{ active: true }])).toBe(false);
    expect(isMultiLocation([])).toBe(false);
  });
});

describe("multiLocationRefusal", () => {
  test("is a blocked-state refusal that names the employees", () => {
    const result = multiLocationRefusal(["ee-1"], "refused.");
    expect(result).toEqual({
      ok: false,
      exitCode: ExitCode.Blocked,
      error: { code: "multi_location_not_supported", message: "refused.", employee_uuids: ["ee-1"] },
    });
  });
});

const ONE = [{ active: true }];
const TWO = [{ active: true }, { active: true }];

type Reply = unknown[] | ApiError | ((attempt: number) => unknown[] | ApiError);

function fakeClient(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    async get(path: string) {
      calls.push(path);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const uuid = path.split("/")[3] ?? "";
      const attempt = attempts.get(uuid) ?? 0;
      attempts.set(uuid, attempt + 1);
      const configured = replies[uuid] ?? ONE;
      const reply = typeof configured === "function" ? configured(attempt) : configured;
      if (reply instanceof ApiError) throw reply;
      return { status: 200, body: reply, headers: {} };
    },
  };
  return { client: client as unknown as ApiClient, calls, maxInFlight: () => maxInFlight };
}

const apiError = (status: number, retryAfterMs?: number) =>
  new ApiError(status, null, status >= 500 ? ExitCode.ApiServer : ExitCode.ApiClient, `GET -> ${status}`, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

const noSleep = async () => {};

describe("findMultiLocationHours", () => {
  test("passes when no one works at more than one location", async () => {
    const { client } = fakeClient({});
    expect(await findMultiLocationHours(client, ["a", "b"], "Fix it.", noSleep)).toBeUndefined();
  });

  test("names everyone at more than one location, checking each employee once", async () => {
    const { client, calls } = fakeClient({ b: TWO, c: TWO });
    const result = await findMultiLocationHours(client, ["a", "b", "b", "c"], "Fix it.", noSleep);
    expect(calls).toHaveLength(3);
    if (!result || result.ok) throw new Error("expected a refusal");
    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(result.error.code).toBe("multi_location_not_supported");
    expect(result.error.employee_uuids).toEqual(["b", "c"]);
    expect(result.error.message).toContain("nothing was saved: employees b, c work at more than one location");
    expect(result.error.message).toContain("Fix it.");
  });

  test("runs at most four lookups at a time", async () => {
    const { client, maxInFlight } = fakeClient({});
    await findMultiLocationHours(
      client,
      Array.from({ length: 12 }, (_, i) => `e${i}`),
      "Fix it.",
      noSleep,
    );
    expect(maxInFlight()).toBe(4);
  });

  test("leaves an unknown employee for the write to report", async () => {
    const { client } = fakeClient({ a: apiError(404) });
    expect(await findMultiLocationHours(client, ["a"], "Fix it.", noSleep)).toBeUndefined();
  });

  test("retries a rate-limited lookup, waiting as long as the API asked", async () => {
    const waits: number[] = [];
    const { client } = fakeClient({ a: (attempt) => (attempt === 0 ? apiError(429, 1500) : TWO) });
    const result = await findMultiLocationHours(client, ["a"], "Fix it.", async (ms) => {
      waits.push(ms);
    });
    expect(waits).toEqual([1500]);
    expect(result?.ok === false && result.error.employee_uuids).toEqual(["a"]);
  });

  test("gives up on a lookup that stays rate limited", async () => {
    const { client, calls } = fakeClient({ a: apiError(429) });
    const result = await findMultiLocationHours(client, ["a"], "Fix it.", noSleep);
    expect(calls).toHaveLength(4);
    if (!result || result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("api_client_error");
    expect(result.error.message).toStartWith("checking the work locations of employee a failed, so nothing was saved:");
  });

  test("still names who it found when other lookups failed, and says who wasn't checked", async () => {
    const { client } = fakeClient({ a: TWO, b: apiError(500) });
    const result = await findMultiLocationHours(client, ["a", "b"], "Fix it.", noSleep);
    if (!result || result.ok) throw new Error("expected a refusal");
    expect(result.error.code).toBe("multi_location_not_supported");
    expect(result.error.employee_uuids).toEqual(["a"]);
    expect(result.error.message).toContain("Couldn't check employee b");
  });

  test("fails the write when a lookup fails and no one was found", async () => {
    const { client } = fakeClient({ b: apiError(500) });
    const result = await findMultiLocationHours(client, ["a", "b"], "Fix it.", noSleep);
    if (!result || result.ok) throw new Error("expected a failure");
    expect(result.exitCode).toBe(ExitCode.ApiServer);
    expect(result.error.code).toBe("api_server_error");
    expect(result.error.message).toContain("employee b failed, so nothing was saved");
  });
});
