import type { BlockedOn } from "./output.ts";

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

/** Plain non-negative decimal: digits with an optional fractional part, nothing else. */
const NON_NEGATIVE_DECIMAL = /^\d+(\.\d+)?$/;

/** Parse a string as a non-negative decimal number, where `0` is a legitimate value.
 *
 * Payroll inputs distinguish "leave untouched" (a blank cell) from "set to zero" (an explicit
 * `0`), so unlike parsePositiveNumber this accepts `0`. Accepts only a plain decimal: this rejects
 * blank/whitespace (`Number("")` -> 0), overflows (`"1e1000"` -> Infinity), and the surprises
 * `Number()` would otherwise wave through for a money/hours cell - hex (`"0x10"` -> 16), binary
 * (`"0b11"` -> 3), and scientific (`"1e3"` -> 1000) - which should error like `$500` or `1,000` do. */
export function parseNonNegativeNumber(raw: string): PositiveNumberResult {
  if (!NON_NEGATIVE_DECIMAL.test(raw)) {
    return { ok: false, reason: `must be a non-negative number, got: ${raw}` };
  }
  return { ok: true, value: Number(raw) };
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

/** Push a `blocked_on` entry for a required `YYYY-MM-DD` field that's missing or malformed. Doesn't
 * narrow `value`, so callers still re-check the local where they need it typed as `string`. */
export function pushRequiredIsoDate(blocked: BlockedOn[], field: string, value: string | undefined): void {
  if (!value) {
    blocked.push({ field, reason: "required (YYYY-MM-DD)" });
  } else if (!isValidIsoDate(value)) {
    blocked.push({ field, reason: "must be a valid date in YYYY-MM-DD format" });
  }
}

/** True for an ISO 8601 date or date-time (e.g. `2026-06-01` or
 * `2026-06-01T09:00:00Z`). Format-level check; range/semantic validation is the API's job. */
export function isValidIso8601(value: string): boolean {
  if (!ISO_8601.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}
