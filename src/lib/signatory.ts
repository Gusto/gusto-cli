/**
 * Signatory presence check, shared by `company onboarding-status` (to inject the
 * signatory blocker) and `company forms` (to refuse signing until one exists).
 *
 * A company has at most one signatory. The list endpoint is the canonical signal:
 * an empty array means no signatory is assigned yet.
 * GET /v1/companies/{uuid}/signatories
 */

/** Minimal read surface of ApiClient this helper needs. */
type ReadClient = { get: <T>(p: string) => Promise<{ body: T }> };

/** True when the company has a signatory assigned. Throws on a failed GET — the
 * caller decides how to degrade (onboarding-status records a partial error rather
 * than fabricating a blocker; forms surfaces the API error). */
export async function companyHasSignatory(client: ReadClient, companyUuid: string): Promise<boolean> {
  const body = (await client.get<unknown>(`/v1/companies/${companyUuid}/signatories`)).body;
  return Array.isArray(body) && body.length > 0;
}
