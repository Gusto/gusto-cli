import { OAuthError, type OAuthHttpOptions } from "./endpoints.ts";
import { registerCliClient } from "./dcr.ts";
import { refreshToken } from "./pkce.ts";
import { TokenRefreshFailedError } from "./refresh-failure.ts";
import type { TokenStore } from "./token-store.ts";
import { type ClientCreds, type StoredSession, hasClientCreds } from "./types.ts";

export const REFRESH_SKEW_MS = 60_000;

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

/** A usable stored token or the reason one could not be produced. */
export type SessionOutcome =
  | { kind: "ok"; token: string }
  /** No access token is stored for this environment. Client registration may still be present. */
  | { kind: "absent" }
  /** Access token expired and no refresh is possible locally - no refresh token, or no client
   * creds to authenticate the refresh with. `expiresAt` is echoed so the message can date it. */
  | { kind: "expired"; expiresAt: number }
  /** A refresh ran and the server rejected it. The stored refresh token is left in place either way:
   * whether it is still good depends on `cause` (a transient failure leaves it usable, an
   * `invalid_grant` does not), and that is a question for the caller reporting the failure, not for
   * the code that discovered it. */
  | { kind: "refresh_failed"; cause: OAuthError };

/** File-only session state. `refreshable` needs a request before it becomes an outcome. */
export type SessionState =
  | Exclude<SessionOutcome, { kind: "refresh_failed" }>
  | { kind: "refreshable"; session: StoredSession & ClientCreds; refreshToken: string; token: string };

/** Classify a loaded slot without renewing anything.
 *
 * An absent `expiresAt` means "unknown", not "expired": the token passes through and a 401 from the
 * API is the only thing that can disprove it. */
export function classifySession(session: StoredSession | null, now: number): SessionState {
  if (!session?.accessToken) return { kind: "absent" };

  const nearExpiry = session.expiresAt != null && now + REFRESH_SKEW_MS >= session.expiresAt;
  if (nearExpiry && session.refreshToken && hasClientCreds(session)) {
    return { kind: "refreshable", session, refreshToken: session.refreshToken, token: session.accessToken };
  }
  // Past expiry with no way to refresh. Sending it buys a 401 saying the credential was refused;
  // the local state also dates the expiry and names the slot it sits in, so reporting from here beats
  // a round trip that comes back knowing less.
  if (session.expiresAt != null && now >= session.expiresAt) {
    return { kind: "expired", expiresAt: session.expiresAt };
  }
  return { kind: "ok", token: session.accessToken };
}

/** Whether `env`'s slot could serve a request, without spending a round trip to find out. A
 * `refreshable` slot counts: the renewal it needs happens on the next command that uses it. Reading
 * only, so asking can't rotate a credential nobody asked us to touch. */
export async function sessionUsable(
  store: TokenStore,
  env: "sandbox" | "production",
  now: () => number = Date.now,
): Promise<boolean> {
  const state = classifySession(await store.load(env), now());
  return state.kind === "ok" || state.kind === "refreshable";
}

/** Resolve the stored session for `env` into a usable token or a reason it isn't one.
 *
 * A refresh that fails inside the skew window while the token is still genuinely valid passes
 * through - the failure isn't actionable yet. Non-OAuth failures (unreadable or corrupt credentials
 * file) propagate; they aren't a credential state, they're a broken machine. */
export async function resolveSessionToken(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  now: () => number = Date.now,
): Promise<SessionOutcome> {
  return resolveSessionTokenAttempt(store, env, http, now, true);
}

async function resolveSessionTokenAttempt(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  now: () => number,
  reconcileConcurrentRefresh: boolean,
): Promise<SessionOutcome> {
  const state = classifySession(await store.load(env), now());
  if (state.kind !== "refreshable") return state;

  try {
    return { kind: "ok", token: await refreshAndStore(store, env, http, state.session, state.refreshToken, now()) };
  } catch (err) {
    // Proactive (within-skew) refresh failed while the token is still genuinely valid, so the
    // failure isn't actionable yet - use it. There is no reactive refresh: a token that turns out
    // to be dead comes back 401 and is reported as `credential_rejected`, not swapped for a fresh
    // one. This is the last chance to refresh, so passing it through bets on the token's clock.
    const expiresAt = state.session.expiresAt;
    if (expiresAt != null && now() < expiresAt) return { kind: "ok", token: state.token };
    if (err instanceof OAuthError) {
      if (reconcileConcurrentRefresh) {
        let latest: StoredSession | null;
        try {
          latest = await store.load(env);
        } catch {
          // Keep the refresh failure we can explain rather than replacing it with a best-effort
          // reconciliation read failure.
          return { kind: "refresh_failed", cause: err };
        }
        if (!sameAuthState(state.session, latest)) {
          return resolveSessionTokenAttempt(store, env, http, now, false);
        }
      }
      return { kind: "refresh_failed", cause: err };
    }
    throw err;
  }
}

/** Whether another process changed the values that determine token resolution while this process
 * was refreshing. Company metadata is deliberately excluded: it cannot make a rejected refresh
 * succeed, while any token, expiry, or client-registration change can. */
function sameAuthState(previous: StoredSession, latest: StoredSession | null): boolean {
  return (
    latest !== null &&
    latest.clientId === previous.clientId &&
    latest.clientSecret === previous.clientSecret &&
    latest.accessToken === previous.accessToken &&
    latest.refreshToken === previous.refreshToken &&
    latest.expiresAt === previous.expiresAt
  );
}

/** The last refresh chance after a 401, since the proactive one already ran before the request
 * started; throws `TokenRefreshFailedError` (not the raw `OAuthError`) so callers don't need to
 * wrap it themselves. */
export async function reactiveRefresh(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  now: () => number = Date.now,
): Promise<string | null> {
  const session = await store.load(env);
  if (!session?.refreshToken || !hasClientCreds(session)) return null;
  try {
    return await refreshAndStore(store, env, http, session, session.refreshToken, now());
  } catch (err) {
    if (!(err instanceof OAuthError)) throw err;
    return await reconcileAfterFailedRefresh(store, env, http, now, session, err);
  }
}

/** Another `gusto` process may have refreshed this session while ours failed - re-classify what's
 * there instead of trusting it blindly, in case it's still near-expiry too. */
async function reconcileAfterFailedRefresh(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  now: () => number,
  previous: StoredSession,
  err: OAuthError,
): Promise<string | null> {
  const failed = () => new TokenRefreshFailedError(err, env);
  let latest: StoredSession | null;
  try {
    latest = await store.load(env);
  } catch {
    throw failed();
  }
  if (latest === null || sameAuthState(previous, latest)) throw failed();

  const state = classifySession(latest, now());
  switch (state.kind) {
    case "ok":
      return state.token;
    case "refreshable":
      try {
        return await refreshAndStore(store, env, http, state.session, state.refreshToken, now());
      } catch (second) {
        // This attempt's own failure, not the one that led here - a transient blip on this second
        // try must not be reported as the first attempt's (possibly unrelated) rejection reason.
        throw second instanceof OAuthError ? new TokenRefreshFailedError(second, env) : second;
      }
    case "absent":
    case "expired":
      throw failed();
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
