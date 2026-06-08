/** A query-string value: a scalar, a list (joined with commas to match Gusto's
 * `?processing_statuses=processed,unprocessed` convention), or undefined (omitted). */
export type QueryValue = string | string[] | undefined;

export type QueryParams = Record<string, QueryValue>;

/** Build a URL query string from `params`. Drops `undefined`, empty-string, and
 * empty-array values; joins array values with commas; URL-encodes keys and values.
 * Returns "" when nothing survives, otherwise a string beginning with "?".
 * Key order follows the insertion order of `params`. */
export function toQueryString(params: QueryParams): string {
  void params;
  throw new Error("not implemented: toQueryString");
}
