import type { ApiClient } from "./api-client.ts";

/** A company location record. Surface the well-known fields; keep the rest as `unknown`
 * so an agent can still read them through `--fields` without us hand-rolling every key
 * the demo/prod API may add. */
export interface LocationRec {
  uuid: string;
  street_1?: string;
  street_2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  phone_number?: string;
  primary?: boolean;
  filing_address?: boolean;
  mailing_address?: boolean;
  active?: boolean;
  [key: string]: unknown;
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
