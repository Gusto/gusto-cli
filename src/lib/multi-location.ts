/** An employee paid at more than one work location has one active work address per location, and the
 * write endpoints can't yet say which location a change is for. */

import type { ApiClient } from "./api-client.ts";
import { fetchAtPath } from "./api-context.ts";
import { malformedResponse } from "./errors.ts";
import { ExitCode } from "./exit-codes.ts";
import type { EnvelopeError } from "./output.ts";
import { isObject } from "./predicates.ts";
import { readString } from "./read-string.ts";
import type { CommandResult } from "./runner.ts";

export const MULTI_LOCATION_NOT_SUPPORTED = "multi_location_not_supported";

const workAddressesPath = (employeeUuid: string): string =>
  `/v1/employees/${encodeURIComponent(employeeUuid)}/work_addresses`;

export function isMultiLocation(workAddresses: readonly unknown[]): boolean {
  return workAddresses.filter((a) => isObject(a) && a.active === true).length > 1;
}

/** `Blocked`, not `ApiClient`: the employee's setup is the precondition that isn't met, so neither
 * retrying nor changing the flags will get this write through. */
export function multiLocationRefusal(
  employeeUuids: readonly string[],
  message: string,
  apiError?: Pick<EnvelopeError, "details" | "request_id">,
): CommandResult<never> {
  return {
    ok: false,
    exitCode: ExitCode.Blocked,
    error: {
      code: MULTI_LOCATION_NOT_SUPPORTED,
      message,
      employee_uuids: [...employeeUuids],
      ...(apiError?.details !== undefined ? { details: apiError.details } : {}),
      ...(apiError?.request_id ? { request_id: apiError.request_id } : {}),
    },
  };
}

export async function employeeIsMultiLocation(
  client: ApiClient,
  employeeUuid: string,
): Promise<CommandResult<boolean>> {
  const path = workAddressesPath(employeeUuid);
  const res = await fetchAtPath<unknown>(client, path);
  if (!res.ok) return res;
  if (!Array.isArray(res.data)) return malformedResponse(`${path} returned a non-array body`);
  return { ok: true, data: isMultiLocation(res.data) };
}

function nothingWritten(failure: Extract<CommandResult, { ok: false }>, step: string): CommandResult<never> {
  return {
    ok: false,
    exitCode: failure.exitCode,
    error: { ...failure.error, message: `${step} failed, so nothing was written: ${failure.error.message}` },
  };
}

/** Precheck for a PUT to one work address: refuse when the address's employee works at more than
 * one location. Takes two reads, since the address names its employee but not their other addresses. */
export async function workAddressMultiLocationCheck(
  client: ApiClient,
  path: string,
): Promise<CommandResult<never> | undefined> {
  const address = await fetchAtPath<unknown>(client, path);
  if (!address.ok) return nothingWritten(address, `reading GET ${path}`);
  const employeeUuid = readString(address.data, "employee_uuid");
  if (employeeUuid === undefined) {
    return malformedResponse(`GET ${path} named no employee_uuid, so nothing was written`);
  }
  const multi = await employeeIsMultiLocation(client, employeeUuid);
  if (!multi.ok) return nothingWritten(multi, "checking the employee's work locations");
  if (!multi.data) return undefined;
  return multiLocationRefusal(
    [employeeUuid],
    `employee ${employeeUuid} works at more than one location, and the CLI can't say which location a ` +
      "work-address change is for yet. Make this change in the Gusto app instead.",
  );
}
