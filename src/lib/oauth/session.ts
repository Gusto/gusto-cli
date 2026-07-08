import { ApiError } from "../api-client.ts";
import type { OAuthHttpOptions } from "./endpoints.ts";
import { registerCliClient } from "./dcr.ts";
import { refreshToken } from "./pkce.ts";
import type { TokenStore } from "./token-store.ts";
import { type ClientCreds, type StoredSession, hasClientCreds } from "./types.ts";

export const REFRESH_SKEW_MS = 60_000;

export class NoSessionError extends Error {
  constructor() {
    super("not logged in. Run `gusto auth login` (or set GUSTO_ACCESS_TOKEN).");
    this.name = "NoSessionError";
  }
}

export async function ensureClientCreds(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
): Promise<ClientCreds> {
  const existing = await store.load(env);
  if (hasClientCreds(existing)) {
    return { clientId: existing.clientId, clientSecret: existing.clientSecret };
  }
  const creds = await registerCliClient(http);
  await store.save(env, { ...(existing ?? {}), ...creds });
  return creds;
}

export async function getValidUserToken(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  now: () => number = Date.now,
): Promise<string | null> {
  const session = await store.load(env);
  if (!session?.accessToken) return null;

  const nearExpiry = session.expiresAt != null && now() + REFRESH_SKEW_MS >= session.expiresAt;
  if (nearExpiry && session.refreshToken && hasClientCreds(session)) {
    try {
      return await refreshAndStore(store, env, http, session, session.refreshToken, now());
    } catch (err) {
      // Proactive (within-skew) refresh failed. If the current token hasn't
      // actually expired, use it - the 401 path refreshes later if needed.
      if (session.expiresAt != null && now() < session.expiresAt) return session.accessToken;
      throw err;
    }
  }
  return session.accessToken;
}

export async function withUserToken<T>(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  fn: (token: string) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const token = await getValidUserToken(store, env, http, now);
  if (token == null) throw new NoSessionError();
  try {
    return await fn(token);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    const session = await store.load(env);
    if (!session?.refreshToken || !hasClientCreds(session)) throw err;
    const refreshed = await refreshAndStore(store, env, http, session, session.refreshToken, now());
    return fn(refreshed);
  }
}

async function refreshAndStore(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  session: StoredSession & ClientCreds,
  refreshTokenValue: string,
  now: number,
): Promise<string> {
  const refreshed = await refreshToken(
    http,
    { refreshToken: refreshTokenValue, creds: { clientId: session.clientId, clientSecret: session.clientSecret } },
    now,
  );
  await store.save(env, {
    ...session,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? refreshTokenValue,
    expiresAt: refreshed.expiresAt,
  });
  return refreshed.accessToken;
}
