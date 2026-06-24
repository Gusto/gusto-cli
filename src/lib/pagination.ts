import type { ValidationResult } from "./runner.ts";

export const DEFAULT_PER = 100;
export const MAX_PER = 500;

export interface PageMode {
  startPage: number;
  per: number;
  maxItems?: number;
  surfaceNext: boolean;
}

export interface PaginationFlags {
  cursor?: string;
  limit?: string;
  all?: boolean;
}

export function encodeCursor(page: number, per: number): string {
  return Buffer.from(`${page}:${per}`).toString("base64url");
}

export function decodeCursor(token: string): { page: number; per: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const match = /^(\d+):(\d+)$/.exec(decoded);
  if (!match) return null;
  const page = Number(match[1]);
  const per = Number(match[2]);
  if (page < 1 || per < 1) return null;
  return { page, per };
}

/** Set `page` and `per` on a (possibly relative) path's query string. Uses a throwaway
 * base purely to parse; only the pathname + search are returned, so the caller resolves
 * the path against the real base URL and enforces same-origin. */
export function withPageParams(path: string, page: number, per: number): string {
  const url = new URL(path, "http://placeholder.invalid");
  url.searchParams.set("page", String(page));
  url.searchParams.set("per", String(per));
  return `${url.pathname}${url.search}`;
}

/** Next page number, or undefined at the end. Trusts an `x-total-pages` header when the
 * response carries one, otherwise falls back to page fullness - a full raw page
 * (count >= per) implies another page may exist, a short/empty page ends the walk. */
export function detectNext(
  headers: Record<string, string>,
  currentPage: number,
  fetchedCount: number,
  per: number,
): number | undefined {
  const totalPages = Number(headers["x-total-pages"]);
  if (Number.isInteger(totalPages) && totalPages > 0) {
    return currentPage < totalPages ? currentPage + 1 : undefined;
  }
  return fetchedCount > 0 && fetchedCount >= per ? currentPage + 1 : undefined;
}

export function parsePaginationFlags(opts: PaginationFlags): ValidationResult<PageMode> {
  const hasCursor = opts.cursor !== undefined;
  const hasLimit = opts.limit !== undefined;
  const hasAll = opts.all === true;

  if (hasCursor && (hasAll || hasLimit)) {
    return {
      ok: false,
      message: "--cursor can't be combined with --all or --limit",
      blocked: [{ field: "cursor", reason: "use --cursor for forward iteration, or --all/--limit on its own" }],
    };
  }

  if (hasLimit) {
    const raw = opts.limit!;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1) {
      return {
        ok: false,
        message: "invalid --limit",
        blocked: [{ field: "limit", reason: `must be a positive integer, got: ${opts.limit}` }],
      };
    }
    return { ok: true, body: { startPage: 1, per: Math.min(n, MAX_PER), maxItems: n, surfaceNext: false } };
  }

  if (hasAll) {
    return { ok: true, body: { startPage: 1, per: MAX_PER, maxItems: undefined, surfaceNext: false } };
  }

  if (opts.cursor !== undefined) {
    const decoded = decodeCursor(opts.cursor);
    if (!decoded) {
      return {
        ok: false,
        message: "invalid --cursor",
        blocked: [
          { field: "cursor", reason: "not a valid pagination cursor; use the next value from a previous response" },
        ],
      };
    }
    return { ok: true, body: { startPage: decoded.page, per: decoded.per, maxItems: decoded.per, surfaceNext: true } };
  }

  return { ok: true, body: { startPage: 1, per: DEFAULT_PER, maxItems: DEFAULT_PER, surfaceNext: true } };
}
