// Generic text-rendering helpers for `--human` output: aligned key-value blocks and
// simple columnar tables. Kept dependency-free and color-agnostic so command renderers
// can compose them; callers decide section titles, ordering, and which fields to show.

type Cell = string | null | undefined;

/** Render aligned `key  value` lines, dropping any pair whose value is null/undefined.
 * Keys are padded to the widest *shown* key so values line up. Returns "" if nothing shows. */
export function kvLines(pairs: [string, Cell][]): string {
  const shown = pairs.filter((p): p is [string, string] => p[1] !== null && p[1] !== undefined);
  if (shown.length === 0) return "";
  const width = Math.max(...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

/** Render a header row plus one line per row, each column padded to its widest cell.
 * Null/undefined cells render blank; trailing whitespace is trimmed. Returns "" for no rows. */
export function table(headers: string[], rows: Cell[][]): string {
  if (rows.length === 0) return "";
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: Cell[]): string =>
    cells
      .map((c, i) => (c ?? "").padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}
