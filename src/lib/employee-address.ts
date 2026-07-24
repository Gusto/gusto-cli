/** Pure request-body builders for the employee address update commands
 * (`employee update-home-address` / `update-work-address`). Kept free of I/O so the
 * flag-to-field mapping and validation are unit-testable; the handlers in
 * `commands/employee.ts` layer auth, the confirmation gate, and the version dance on top.
 *
 * Both builders emit a partial update: only the flags the caller passed become body keys, so an
 * unset flag leaves that field untouched server-side. Empty flag values are rejected (not forwarded)
 * so a stray `--city ""` can't blank a field the caller didn't mean to change. A caller-supplied
 * `--record-version` is carried into the body (where `getAndInjectVersion` treats it as authoritative
 * and skips the auto-fetch), but a version alone is not an update - at least one address field must
 * be present. Format-only checks live here (ISO date, boolean); the API owns semantic validation
 * (real state, deliverable ZIP). */

import type { BlockedOn } from "./output.ts";
import { isValidIsoDate } from "./parse.ts";
import type { ValidationResult } from "./runner.ts";

export interface HomeAddressUpdateOpts {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  effectiveDate?: string;
  courtesyWithholding?: string;
  recordVersion?: string;
}

export interface WorkAddressUpdateOpts {
  locationUuid?: string;
  effectiveDate?: string;
  recordVersion?: string;
}

/** Typed PUT bodies (mirrors the `PayScheduleBody`/`PayrollUpdateBody` convention) so a mistyped
 * field key or wrong-typed value is a compile error rather than an API rejection. All fields are
 * optional because the update is partial. Written as type aliases (not interfaces) so they stay
 * assignable to the `Record<string, unknown>` that `putResourceWithVersion` accepts. */
type HomeAddressBody = {
  street_1?: string;
  street_2?: string;
  city?: string;
  state?: string;
  zip?: string;
  effective_date?: string;
  courtesy_withholding?: boolean;
  version?: string;
};

type WorkAddressBody = {
  location_uuid?: string;
  effective_date?: string;
  version?: string;
};

const HOME_ADDRESS_FIELDS = "street-1, street-2, city, state, zip, effective-date, courtesy-withholding";
const WORK_ADDRESS_FIELDS = "location-uuid, effective-date";

/** Parse a `true`/`false` flag value; undefined for anything else. */
function parseBoolean(raw: string): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/** An optional string flag: undefined when absent, a blocked_on entry (and undefined) when empty,
 * else the value. Rejecting empty keeps a stray `--flag ""` from blanking a field on a partial
 * update, and mirrors the explicit-rejection the date/boolean flags already use. */
function optionalString(raw: string | undefined, field: string, blocked: BlockedOn[]): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    blocked.push({ field, reason: "must not be empty" });
    return undefined;
  }
  // Return the trimmed value: the API strips surrounding whitespace anyway, and returning `raw`
  // would forward the padding we just validated against.
  return trimmed;
}

/** Assign `value` to `body[key]` only when defined, with the key checked against the body type so a
 * typo is a compile error. */
function setField<T, K extends keyof T>(body: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) body[key] = value;
}

/** Add an ISO `YYYY-MM-DD` effective_date to `body`, or a blocked_on entry if it's malformed. */
function setEffectiveDate(body: { effective_date?: string }, blocked: BlockedOn[], raw: string | undefined): void {
  if (raw === undefined) return;
  if (isValidIsoDate(raw)) body.effective_date = raw;
  else blocked.push({ field: "effective-date", reason: "must be a valid date in YYYY-MM-DD format" });
}

/** Finalize a builder: reject an empty body (a version-only payload is a no-op), surface any
 * collected format errors, then attach the (already-validated non-empty) version. Generic over the
 * body type so each builder keeps its precise return type (no widening cast at the call site) while
 * key typos stay caught at construction. Shared so the home/work builders can't drift on the
 * "nothing to update" rule or version handling. */
function finalize<T extends { version?: string }>(
  body: T,
  blocked: BlockedOn[],
  fields: string,
  version: string | undefined,
): ValidationResult<T> {
  if (Object.keys(body).length === 0 && blocked.length === 0) {
    return {
      ok: false,
      message: "nothing to update",
      blocked: [{ field: "fields", reason: `supply at least one of: ${fields}` }],
    };
  }
  if (blocked.length > 0) return { ok: false, message: "invalid arguments", blocked };
  if (version !== undefined) body.version = version;
  return { ok: true, body };
}

/** Build the PUT body for `/v1/home_addresses/{uuid}` from the command flags. */
export function buildHomeAddressUpdate(opts: HomeAddressUpdateOpts): ValidationResult<HomeAddressBody> {
  const body: HomeAddressBody = {};
  const blocked: BlockedOn[] = [];

  setField(body, "street_1", optionalString(opts.street1, "street-1", blocked));
  setField(body, "street_2", optionalString(opts.street2, "street-2", blocked));
  setField(body, "city", optionalString(opts.city, "city", blocked));
  setField(body, "state", optionalString(opts.state, "state", blocked));
  setField(body, "zip", optionalString(opts.zip, "zip", blocked));
  setEffectiveDate(body, blocked, opts.effectiveDate);

  if (opts.courtesyWithholding !== undefined) {
    const parsed = parseBoolean(opts.courtesyWithholding);
    if (parsed === undefined) blocked.push({ field: "courtesy-withholding", reason: "must be true or false" });
    else body.courtesy_withholding = parsed;
  }

  const version = optionalString(opts.recordVersion, "record-version", blocked);
  return finalize(body, blocked, HOME_ADDRESS_FIELDS, version);
}

/** Build the PUT body for `/v1/work_addresses/{uuid}` from the command flags. Work addresses point
 * at a company location (`location_uuid`) rather than free-form street fields. */
export function buildWorkAddressUpdate(opts: WorkAddressUpdateOpts): ValidationResult<WorkAddressBody> {
  const body: WorkAddressBody = {};
  const blocked: BlockedOn[] = [];

  setField(body, "location_uuid", optionalString(opts.locationUuid, "location-uuid", blocked));
  setEffectiveDate(body, blocked, opts.effectiveDate);

  const version = optionalString(opts.recordVersion, "record-version", blocked);
  return finalize(body, blocked, WORK_ADDRESS_FIELDS, version);
}
