export interface GeneralLedgerOpts {
  aggregation?: string;
  integrationType?: string;
}

export interface GeneralLedgerBody {
  aggregation: string;
  integration_type: string;
}

interface ReportStatusBody {
  status?: string;
}

/** Build the POST body for `POST /v1/payrolls/{uuid}/reports/general_ledger`,
 * applying the server defaults (`aggregation: "default"`, `integration_type: ""`). */
export function buildGeneralLedgerBody(opts: GeneralLedgerOpts): GeneralLedgerBody {
  void opts;
  throw new Error("not implemented: buildGeneralLedgerBody");
}

/** True once `GET /v1/reports/{uuid}` reports the report finished generating
 * and its download URL is ready. Drives the `poll()` success predicate. */
export function isReportSucceeded(body: ReportStatusBody): boolean {
  void body;
  throw new Error("not implemented: isReportSucceeded");
}

/** True once the report request has terminally failed. Drives the `poll()`
 * failure predicate so we stop polling instead of waiting out the timeout. */
export function isReportFailed(body: ReportStatusBody): boolean {
  void body;
  throw new Error("not implemented: isReportFailed");
}
