import type { ApiClient } from "./api-client.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CommandResult } from "./runner.ts";

export interface LocationRec {
  uuid: string;
  primary?: boolean;
  filing_address?: boolean;
}

/** Thrown when /locations returns a 200 with a non-array body so callers can
 * distinguish a real "no locations" empty list from a malformed response. */
export class MalformedLocationsBodyError extends Error {
  constructor(companyUuid: string) {
    super(`/v1/companies/${companyUuid}/locations returned a non-array body`);
    this.name = "MalformedLocationsBodyError";
  }
}

/** The shared `malformed_response` envelope both /locations consumers emit when the
 * API returns a non-array body. Exit code matches a regular API client failure. */
export function malformedLocationsResult(err: MalformedLocationsBodyError): CommandResult<never> {
  return {
    ok: false,
    exitCode: ExitCode.ApiClient,
    error: { code: "malformed_response", message: err.message },
  };
}

/** GET /v1/companies/{company_uuid}/locations. Throws `MalformedLocationsBodyError`
 * on a non-array body; callers catch + map to `malformedLocationsResult`. */
export async function fetchCompanyLocations(client: ApiClient, companyUuid: string): Promise<LocationRec[]> {
  const res = await client.get<LocationRec[]>(`/v1/companies/${companyUuid}/locations`);
  if (!Array.isArray(res.body)) throw new MalformedLocationsBodyError(companyUuid);
  return res.body;
}

/** Pick the company's primary location. Prefer an explicit `primary: true`, then a
 * `filing_address: true` (the onboarding primary location doubles as the filing
 * address), then fall back to the first record. Returns undefined when the list is empty. */
export function pickPrimaryLocation(locations: LocationRec[]): LocationRec | undefined {
  if (locations.length === 0) return undefined;
  return locations.find((l) => l.primary === true) ?? locations.find((l) => l.filing_address === true) ?? locations[0];
}
