/** Raised when CSV text is structurally malformed (e.g. a quoted field is never closed). */
export class CsvError extends Error {}

/** Parse CSV text into rows of string cells, RFC 4180 style: double-quoted fields may contain
 * commas, newlines, and escaped quotes (`""`). Accepts LF or CRLF line endings and strips a
 * leading UTF-8 BOM (Excel exports add one). Cells are returned verbatim - trimming and blank-row
 * filtering are the caller's job, since whitespace can be significant in some columns. Throws
 * CsvError on an unterminated quoted field. */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"') {
        // A doubled quote inside a quoted field is a literal quote; anything else ends the field.
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      // A bare CR is dropped so a CRLF break is handled by the LF branch above.
      field += c;
    }
  }

  if (inQuotes) throw new CsvError('unterminated quoted field (an opening " has no closing ")');

  // Flush the final field/row when the file doesn't end in a newline. A trailing newline leaves
  // both empty here, so we don't emit a phantom blank row for it.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
