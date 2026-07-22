/** True for any non-null object, arrays included. Narrows `unknown` to an indexable record so
 * callers can read properties off an API body without unsafe casts. Deliberately array-permissive;
 * for the array-rejecting variant see `isPlainObject`/`isRecord` in their respective modules. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
