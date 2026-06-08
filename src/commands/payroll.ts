import type { BlockedOn } from "../lib/output.ts";
import type { QueryParams } from "../lib/query.ts";

export interface PayrollListOpts {
  processingStatus?: string;
  payrollType?: string;
  startDate?: string;
  endDate?: string;
  dateFilterBy?: string;
  include?: string;
  sortOrder?: string;
  companyUuid?: string;
  token?: string;
}

export type PayrollListQueryResult = { ok: true; query: QueryParams } | { ok: false; blocked: BlockedOn[] };

/** Map `payroll list` flags onto the API's `GET /v1/companies/{uuid}/payrolls`
 * query params, validating that any supplied dates are ISO `YYYY-MM-DD`. The
 * range rules (end_date at most 3 months out; start/end at most 1 year apart)
 * are enforced server-side and surfaced through the API error envelope, so they
 * are intentionally not duplicated here. */
export function buildPayrollListQuery(opts: PayrollListOpts): PayrollListQueryResult {
  void opts;
  throw new Error("not implemented: buildPayrollListQuery");
}
