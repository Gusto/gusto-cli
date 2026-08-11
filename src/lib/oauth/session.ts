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

/** Why the stored session couldn't produce a usable token, or the token if it could.
 *
 * The failure kinds are distinct because the cheapest action that can work differs by kind, and this
 * is the one place that rule is stated: `gusto auth login` is the expensive answer - it needs a human
 * at a browser an agent on a headless box can't produce, and a successful one mints a new grant that
 * invalidates the refresh token it replaces, breaking anything else holding that credential. So it is
 * the recovery only where nothing cheaper exists. "Nothing on file" and "on file but the refresh was
 * rejected" are therefore opposite states, not shades of one, and callers map each kind to its own
 * error code rather than collapsing them. `cause` decides which recovery a `refresh_failed` gets - see
 * `refreshFailureMessage` in `api-context.ts`. */
export type SessionOutcome =
  | { kind: "ok"; token: string }
  /** No credential slot for this environment, or a slot with no access token in it. */
  | { kind: "absent" }
  /** Access token expired and no refresh is possible locally - no refresh token, or no client
   * creds to authenticate the refresh with. `expiresAt` is echoed so the message can date it. */
  | { kind: "expired"; expiresAt: number }
  /** A refresh ran and the server rejected it. The stored refresh token is left in place either way:
   * whether it is still good depends on `cause` (a transient failure leaves it usable, an
   * `invalid_grant` does not), and that is a question for the caller reporting the failure, not for
   * the code that discovered it. */
  | { kind: "refresh_failed"; cause: OAuthError };

/** What a stored slot is, judged from the file alone. Everything `SessionOutcome` has except
 * `refresh_failed`, which only a request can produce, plus the state that needs one: `refreshable`,
 * an access token at or near expiry with the refresh token and client creds to renew it.
 *
 * Split out so a caller that must not touch the network - `otherEnvHint`, deciding whether the other
 * environment is worth pointing at - can read the same verdict `resolveSessionToken` acts on, instead
 * of re-deriving "usable" from a truthy access token that may have expired weeks ago. */
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
    if (err instanceof OAuthError) return { kind: "refresh_failed", cause: err };
    throw err;
  }
}

/** Run `fn` with the session's token, refreshing on near-expiry and once more if the call comes back
 * 401. `NoSessionError` for the two states that need a login (nothing on file, expired with no way to
 * renew); the `OAuthError` itself when a refresh ran and the server rejected it, since a caller that
 * can't tell that state from absence would answer a still-usable refresh token with a login.
 *
 * No production caller yet - reactive refresh belongs per-request inside `ApiClient`, not around a
 * whole operation, which would replay a paginated walk or a poll. Commands resolve their token
 * through `resolveSessionToken` instead, which reports the three failure states apart. */
export async function withUserToken<T>(
  store: TokenStore,
  env: "sandbox" | "production",
  http: OAuthHttpOptions,
  fn: (token: string) => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const outcome = await resolveSessionToken(store, env, http, now);
  if (outcome.kind === "refresh_failed") throw outcome.cause;
  if (outcome.kind !== "ok") throw new NoSessionError();
  const token = outcome.token;
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
