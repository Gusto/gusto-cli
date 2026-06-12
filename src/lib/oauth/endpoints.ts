// OAuth/DCR endpoints aren't bearer-authenticated, so they can't use ApiClient
// (which always sends Authorization: Bearer). fetch is injectable for tests.

import type { TokenSet } from "./types.ts";

export const OAUTH_PATHS = {
  register: "/v1/mcp/oauth/register",
  token: "/v1/mcp/oauth/token",
  authorize: "/v1/mcp/oauth/authorize",
  revoke: "/oauth/revoke",
} as const;

export const DEFAULT_OAUTH_TIMEOUT_MS = 30_000;

export class OAuthError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly requestId?: string;
  constructor(status: number, body: unknown, message: string, requestId?: string) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

export interface OAuthHttpOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

export function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

async function send(opts: OAuthHttpOptions, path: string, init: RequestInit): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = joinUrl(opts.baseUrl, path);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthError(0, null, `network error calling ${path}: ${msg}`);
  }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const text = await response.text();
  const body: unknown = text.length === 0 ? null : safeJson(text);
  if (!response.ok) {
    throw new OAuthError(response.status, body, `${path} -> ${response.status}`, requestId);
  }
  return body;
}

export function postJson(opts: OAuthHttpOptions, path: string, body: unknown): Promise<unknown> {
  return send(opts, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

export function postForm(
  opts: OAuthHttpOptions,
  path: string,
  form: Record<string, string>,
  authHeader?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;
  return send(opts, path, { method: "POST", headers, body: new URLSearchParams(form).toString() });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export function expiresAtFrom(expiresIn: unknown, now: number): number | undefined {
  return typeof expiresIn === "number" ? now + expiresIn * 1000 : undefined;
}

/** Parse an OAuth token response into a TokenSet; missing refresh/expiry are left undefined. */
export function toTokenSet(body: unknown, now: number): TokenSet {
  const { access_token, refresh_token, expires_in, scope } = body as TokenResponse;
  if (typeof access_token !== "string") {
    throw new Error("token response missing access_token");
  }
  return {
    accessToken: access_token,
    refreshToken: typeof refresh_token === "string" ? refresh_token : undefined,
    expiresAt: expiresAtFrom(expires_in, now),
    scope: typeof scope === "string" ? scope : undefined,
  };
}
