import type { ApiClient } from "./api-client.ts";

export interface LocationRec {
  uuid: string;
  primary?: boolean;
  filing_address?: boolean;
}

/** GET /v1/companies/{company_uuid}/locations. Tolerates a non-array (malformed 200)
 * by returning an empty list so callers don't have to re-validate the body. */
export async function fetchCompanyLocations(client: ApiClient, companyUuid: string): Promise<LocationRec[]> {
  const res = await client.get<LocationRec[]>(`/v1/companies/${companyUuid}/locations`);
  return Array.isArray(res.body) ? res.body : [];
}

/** Pick the company's primary location. Prefer an explicit `primary: true`, then a
 * `filing_address: true` (the onboarding primary location doubles as the filing
 * address), then fall back to the first record. Returns undefined when the list is empty. */
export function pickPrimaryLocation(locations: LocationRec[]): LocationRec | undefined {
  if (locations.length === 0) return undefined;
  return locations.find((l) => l.primary === true) ?? locations.find((l) => l.filing_address === true) ?? locations[0];
}
