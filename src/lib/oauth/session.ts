import { ApiError } from "../api-client.ts";
import { OAuthError, type OAuthHttpOptions } from "./endpoints.ts";
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

/** Why the stored session couldn't produce a usable token, or the token if it could. The three
 * failure kinds are distinct on purpose: "nothing on file" and "on file but the refresh was
 * rejected" call for opposite actions - the second still has a credential worth retrying against,
 * and answering it with an interactive login is both needlessly expensive and impossible where no
 * browser exists. Callers map each kind to its own error code, and `refresh_failed` must point at a
 * retry rather than at `gusto auth login`. */
export type SessionOutcome =
  | { kind: "ok"; token: string }
  /** No credential slot for this environment, or a slot with no access token in it. */
  | { kind: "absent" }
  /** Access token expired and no refresh is possible locally - no refresh token, or no client
   * creds to authenticate the refresh with. `expiresAt` is echoed so the message can date it. */
  | { kind: "expired"; expiresAt: number }
  /** A refresh ran and the server rejected it. The stored refresh token is left in place: it may
   * still be good (a transient failure), and it is the only way back in that doesn't need a login. */
  | { kind: "refresh_failed"; cause: OAuthError };

/** Resolve the stored session for `env` into a usable token or a reason it isn't one.
 *
 * An absent `expiresAt` means "unknown", not "expired": the token passes through and a 401 from
 * the API is the only thing that can disprove it. A refresh that fails inside the skew window
 * while the token is still genuinely valid also passes through - the failure isn't actionable yet.
 * Non-OAuth failures (unreadable or corrupt credentials file) propagate; they aren't a credential
 * state, they're a broken machine. */
export async function resolveSessionToken(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  now: () => number = Date.now,
): Promise<SessionOutcome> {
  const session = await store.load(env);
  if (!session?.accessToken) return { kind: "absent" };

  const nearExpiry = session.expiresAt != null && now() + REFRESH_SKEW_MS >= session.expiresAt;
  if (nearExpiry && session.refreshToken && hasClientCreds(session)) {
    try {
      return { kind: "ok", token: await refreshAndStore(store, env, http, session, session.refreshToken, now()) };
    } catch (err) {
      // Proactive (within-skew) refresh failed while the token is still genuinely valid, so the
      // failure isn't actionable yet - use it. There is no reactive refresh: a token that turns out
      // to be dead comes back 401 and is reported as `credential_rejected`, not swapped for a fresh
      // one. This is the last chance to refresh, so passing it through bets on the token's clock.
      if (session.expiresAt != null && now() < session.expiresAt) return { kind: "ok", token: session.accessToken };
      if (err instanceof OAuthError) return { kind: "refresh_failed", cause: err };
      throw err;
    }
  }
  // Past expiry with no way to refresh. Sending it buys a 401 saying the credential was refused;
  // the local state also dates the expiry and names the slot it sits in, so reporting from here beats
  // a round trip that comes back knowing less.
  if (session.expiresAt != null && now() >= session.expiresAt) {
    return { kind: "expired", expiresAt: session.expiresAt };
  }
  return { kind: "ok", token: session.accessToken };
}

/** The session's token, refreshed on near-expiry. Null when nothing is on file or the token expired
 * with no way to renew it; throws the `OAuthError` when a refresh ran and the server rejected it,
 * since a caller reduced to null can't tell that state from absence and would answer a still-usable
 * refresh token with a login. Callers that need all three apart want `resolveSessionToken`. */
export async function getValidUserToken(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  now: () => number = Date.now,
): Promise<string | null> {
  const outcome = await resolveSessionToken(store, env, http, now);
  if (outcome.kind === "ok") return outcome.token;
  if (outcome.kind === "refresh_failed") throw outcome.cause;
  return null;
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
