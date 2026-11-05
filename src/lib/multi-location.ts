/** An employee paid at more than one work location has one active work address per location, and the
 * write endpoints can't yet say which location a change is for. */

import { ApiError, type ApiClient } from "./api-client.ts";
import { fetchAtPath, resolveApiContext } from "./api-context.ts";
import { malformedResponse } from "./errors.ts";
import { ExitCode } from "./exit-codes.ts";
import type { GlobalFlags } from "./global-flags.ts";
import { toResult } from "./handle-api-error.ts";
import { isObject } from "./predicates.ts";
import type { CommandResult } from "./runner.ts";

export const MULTI_LOCATION_NOT_SUPPORTED = "multi_location_not_supported";

const LOOKUP_CONCURRENCY = 4;
const RATE_LIMIT_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;

export const employeeWorkAddressesPath = (employeeUuid: string): string =>
  `/v1/employees/${encodeURIComponent(employeeUuid)}/work_addresses`;

export function isMultiLocation(workAddresses: readonly unknown[]): boolean {
  return workAddresses.filter((a) => isObject(a) && a.active === true).length > 1;
}

/** `Blocked`, not `ApiClient`: the employee's setup is the precondition that isn't met, so neither
 * retrying nor changing the flags will get this write through. */
export function multiLocationRefusal(employeeUuids: readonly string[], message: string): CommandResult<never> {
  return {
    ok: false,
    exitCode: ExitCode.Blocked,
    error: { code: MULTI_LOCATION_NOT_SUPPORTED, message, employee_uuids: [...employeeUuids] },
  };
}

export async function fetchWorkAddresses<T = unknown>(
  client: ApiClient,
  employeeUuid: string,
): Promise<CommandResult<T[]>> {
  const path = employeeWorkAddressesPath(employeeUuid);
  const res = await fetchAtPath<unknown>(client, path);
  if (!res.ok) return res;
  if (!Array.isArray(res.data)) return malformedResponse(`${path} returned a non-array body`);
  return { ok: true, data: res.data as T[] };
}

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lookUpEmployee(client: ApiClient, employeeUuid: string, sleep: Sleep): Promise<CommandResult<boolean>> {
  const path = employeeWorkAddressesPath(employeeUuid);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.get<unknown>(path);
      if (!Array.isArray(res.body)) return malformedResponse(`${path} returned a non-array body`);
      return { ok: true, data: isMultiLocation(res.body) };
    } catch (err) {
      // An unknown employee is the write's error to report, with the API's own wording.
      if (err instanceof ApiError && err.status === 404) return { ok: true, data: false };
      if (err instanceof ApiError && err.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await sleep(Math.min(err.retryAfterMs ?? 2 ** attempt * 1000, MAX_RATE_LIMIT_WAIT_MS));
        continue;
      }
      return toResult(err);
    }
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const named = (uuids: readonly string[]): string =>
  `${uuids.length === 1 ? "employee" : "employees"} ${uuids.join(", ")}`;

/** Refuse an hours write when any of `employeeUuids` works at more than one location. Everyone found
 * is named even when other lookups failed; a failed lookup with no one found fails the write, since
 * an unchecked employee's hours could still land on the wrong location. */
export async function findMultiLocationHours(
  client: ApiClient,
  employeeUuids: readonly string[],
  recovery: string,
  sleep: Sleep = defaultSleep,
): Promise<CommandResult<never> | undefined> {
  const unique = [...new Set(employeeUuids)];
  const results = await mapWithConcurrency(unique, LOOKUP_CONCURRENCY, (uuid) => lookUpEmployee(client, uuid, sleep));
  const multi = unique.filter((_, i) => {
    const r = results[i];
    return r?.ok === true && r.data;
  });
  const unchecked = unique.filter((_, i) => results[i]?.ok === false);

  if (multi.length > 0) {
    return multiLocationRefusal(
      multi,
      `nothing was saved: ${named(multi)} ${multi.length === 1 ? "works" : "work"} at more than one location, ` +
        `and the CLI can't say which location hours are for yet. ${recovery}` +
        (unchecked.length > 0 ? ` Couldn't check ${named(unchecked)}; re-running checks them again.` : ""),
    );
  }
  const failure = results.find((r): r is Extract<CommandResult<boolean>, { ok: false }> => r.ok === false);
  if (!failure) return undefined;
  return {
    ok: false,
    exitCode: failure.exitCode,
    error: {
      ...failure.error,
      message:
        `checking the work locations of ${named(unchecked)} failed, so nothing was saved: ` + failure.error.message,
    },
  };
}

/** Resolve auth and run findMultiLocationHours before an hours write. A dry-run with no credentials
 * skips the check, since it sends nothing either way. */
export async function multiLocationHoursPrecheck(
  globals: GlobalFlags,
  opts: { tokenStdin?: boolean; dryRun?: boolean },
  employeeUuids: readonly string[],
  recovery: string,
): Promise<CommandResult<never> | undefined> {
  if (employeeUuids.length === 0) return undefined;
  const resolved = await resolveApiContext(globals, { tokenStdin: opts.tokenStdin, requireCompany: false });
  if (!resolved.ok) return opts.dryRun && resolved.reason === "credentials" ? undefined : resolved.result;
  return findMultiLocationHours(resolved.ctx.client, employeeUuids, recovery);
}
