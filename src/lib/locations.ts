import type { ApiClient } from "./api-client.ts";
import { malformedResponse } from "./errors.ts";
import type { CommandResult } from "./runner.ts";

export interface LocationRec {
  uuid: string;
  primary?: boolean;
  filing_address?: boolean;
  state?: string;
  active?: boolean;
}

/** GET /v1/companies/{company_uuid}/locations. Returns a `CommandResult` so
 * callers can `if (!res.ok) return res;` and propagate a structured
 * `malformed_response` envelope when the API returns a non-array body (which
 * the old behavior silently coerced to "no locations" - misleading the user
 * about the actual cause). Network / API errors still throw from the client
 * and propagate to the runner's `toResult` mapper as before. */
export async function fetchCompanyLocations(
  client: ApiClient,
  companyUuid: string,
): Promise<CommandResult<LocationRec[]>> {
  const res = await client.get<LocationRec[]>(`/v1/companies/${companyUuid}/locations`);
  if (!Array.isArray(res.body)) {
    return malformedResponse(`/v1/companies/${companyUuid}/locations returned a non-array body`);
  }
  return { ok: true, data: res.body };
}

/** Pick the company's primary location. Prefer an explicit `primary: true`, then a
 * `filing_address: true` (the onboarding primary location doubles as the filing
 * address), then fall back to the first record. Returns undefined when the list is empty. */
export function pickPrimaryLocation(locations: LocationRec[]): LocationRec | undefined {
  if (locations.length === 0) return undefined;
  return locations.find((l) => l.primary === true) ?? locations.find((l) => l.filing_address === true) ?? locations[0];
}

/** Find an active company location in `state` (case-insensitive). A location with no
 * `active` flag is treated as active - the field is only ever set false, never omitted
 * to mean false. Used to resolve `--work-state <ST>` to the `location_uuid` an employee's
 * work address must reference. */
export function findLocationForState(locations: LocationRec[], state: string): LocationRec | undefined {
  const target = state.toUpperCase();
  return locations.find((l) => l.active !== false && l.state?.toUpperCase() === target);
}
