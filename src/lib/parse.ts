export type PositiveNumberResult = { ok: true; value: number } | { ok: false; reason: string };

/** Parse a string as a positive, finite number.
 *
 * Rejects non-finite values such as `"1e1000"`, which `Number()` coerces to `Infinity` —
 * that would otherwise pass a bare `> 0` check and reach the API as the string `"Infinity"`.
 *
 * Shared by employee compensation and contractor wage validation so the two can't drift. */
export function parsePositiveNumber(raw: string): PositiveNumberResult {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, reason: `must be a positive number, got: ${raw}` };
  }
  return { ok: true, value: num };
}

/** Parse a string as a non-negative, finite number, where `0` is a legitimate value.
 *
 * Payroll inputs distinguish "leave untouched" (a blank cell) from "set to zero" (an explicit
 * `0`), so unlike parsePositiveNumber this accepts `0`. Callers must reject blank/whitespace input
 * before calling - `Number("")` and `Number("   ")` both coerce to `0`, which would otherwise slip
 * through as a real zero. Rejects non-finite overflows (`"1e1000"` -> Infinity) for the same reason
 * as parsePositiveNumber. */
export function parseNonNegativeNumber(raw: string): PositiveNumberResult {
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    return { ok: false, reason: `must be a non-negative number, got: ${raw}` };
  }
  return { ok: true, value: num };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/;

/** True for a real calendar date in `YYYY-MM-DD` form (rejects bad formats and
 * impossible dates such as `2026-02-30`). */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/** True for an ISO 8601 date or date-time (e.g. `2026-06-01` or
 * `2026-06-01T09:00:00Z`). Format-level check; range/semantic validation is the API's job. */
export function isValidIso8601(value: string): boolean {
  if (!ISO_8601.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}
