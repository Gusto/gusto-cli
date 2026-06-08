/** A query-string value: a scalar, a list (joined with commas to match Gusto's
 * `?processing_statuses=processed,unprocessed` convention), or undefined (omitted). */
export type QueryValue = string | string[] | undefined;

export type QueryParams = Record<string, QueryValue>;

/** Build a URL query string from `params`. Drops `undefined`, empty-string, and
 * empty-array values; joins array values with commas; URL-encodes keys and values.
 * Returns "" when nothing survives, otherwise a string beginning with "?".
 * Key order follows the insertion order of `params`. */
export function toQueryString(params: QueryParams): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const joined = Array.isArray(value) ? value.join(",") : value;
    if (joined === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(joined)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}
