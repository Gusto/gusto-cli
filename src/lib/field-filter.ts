/** Helpers for the global `--fields` output selector: parse the flag value, discover the
 * available top-level keys, and project the success envelope's `data` down to chosen keys. */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a comma-separated `--fields` value into an ordered, de-duplicated key list.
 * Trims whitespace, drops empty segments, and keeps the first occurrence of repeats. */
export function parseFieldList(raw: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const segment of raw.split(",")) {
    const key = segment.trim();
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function pick(obj: Record<string, unknown>, wanted: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Pin to source key order — the requested order is intentionally ignored so the output
  // shape stays stable regardless of how the caller spelled the flag.
  for (const key of Object.keys(obj)) {
    if (wanted.has(key)) out[key] = obj[key];
  }
  return out;
}

/** Project `data` down to the named top-level keys. Objects are picked in source order; arrays are
 * filtered per-row (so non-uniform rows keep only the keys they have); absent keys are silently
 * omitted rather than erroring. Primitives, null/undefined, and non-object array elements pass
 * through untouched, as does an empty key list. */
export function selectFields(data: unknown, keys: string[]): unknown {
  if (keys.length === 0) return data;
  const wanted = new Set(keys);
  if (Array.isArray(data)) {
    return data.map((row) => (isPlainObject(row) ? pick(row, wanted) : row));
  }
  if (isPlainObject(data)) {
    return pick(data, wanted);
  }
  return data;
}

/** Partition requested `--fields` keys against the fields actually present in `data`, computing
 * `availableFields` exactly once. Returns both the `available` list (for error messaging) and the
 * `unknown` keys (requested but present nowhere — measured against the union of keys across array
 * rows, so a key in only *some* rows stays known). These unknowns are almost always typos.
 *
 * When `data` exposes no fields at all (empty array/object, primitive, null) `unknown` is empty:
 * there is no field universe to validate against, so a genuinely empty result like
 * `employee list --fields uuid` on a company with no employees still projects cleanly to `[]`
 * instead of erroring on a "missing" field. */
export function partitionFields(data: unknown, keys: string[]): { available: string[]; unknown: string[] } {
  const available = availableFields(data);
  if (available.length === 0) return { available, unknown: [] };
  const set = new Set(available);
  return { available, unknown: keys.filter((key) => !set.has(key)) };
}

/** List the top-level field names available on `data`, in first-seen source order. For an array,
 * returns the union of keys across all object rows. Primitives, null/undefined, and empty
 * collections yield an empty list. */
export function availableFields(data: unknown): string[] {
  if (Array.isArray(data)) {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const row of data) {
      if (!isPlainObject(row)) continue;
      for (const key of Object.keys(row)) {
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
      }
    }
    return keys;
  }
  if (isPlainObject(data)) return Object.keys(data);
  return [];
}
