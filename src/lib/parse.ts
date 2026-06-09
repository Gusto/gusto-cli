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
