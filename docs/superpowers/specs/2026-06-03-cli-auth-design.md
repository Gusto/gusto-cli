# CLI Auth - Design

**Date:** 2026-06-03
**Tickets:** Closes AINT-561 (CLI auth flow). Partially lands AINT-562 (`company provision` only - the command that exercises the new grant).
**Depends on:** [zenpayroll #344183](https://github.com/Gusto/zenpayroll/pull/344183) (AINT-554, server-side `client_type=cli` + `system_access` grant) merging first.

## Goal

End-to-end auth for the Gusto CLI in a single PR: first-run dynamic client registration (DCR), OAuth PKCE login, token storage with refresh, the `system_access` mint, and the Mode 2 re-auth path. Plus `gusto company provision` as the one command that exercises the new grant end-to-end so we can prove auth works.

## Scope

**In - auth (AINT-561)**
- First-run DCR (`client_type=cli`, loopback redirect URIs)
- `gusto auth login` / `logout` / `whoami`
- Token storage: 0600 file (`~/.config/gusto/credentials.toml`)
- Refresh-on-401 for user tokens; re-mint-on-401 for system tokens
- `system_access` token mint
- Mode 2 re-auth (shares the login PKCE machinery)

**In - one command (AINT-562 partial)**
- `gusto company provision` - the auth test driver. Minimal input (`--input <file.json>` / `--example`); full input ergonomics deferred.

**Out (stays in the AINT-562 PR)**
- `gusto company status` / `show` / `finish` - read/navigation commands, no new auth surface to validate. See Out of scope / YAGNI below.

## Server contract (locked from #344183 + existing routes)

| Endpoint | Grant / method | Request | Response |
|---|---|---|---|
| `POST /v1/mcp/oauth/register` | DCR | `{client_type:"cli", redirect_uris:["http://127.0.0.1/callback"]}` (fixed path, no port - see below) | `{client_id, client_secret}` |
| `POST /v1/mcp/oauth/token` | `authorization_code` + PKCE | `code`, `code_verifier`, `client_id`, `redirect_uri` | access **+ refresh** token, CLI partner scopes |
| `POST /v1/mcp/oauth/token` | `system_access` | client_id + client_secret (Basic auth); no code, no refresh | access token, scopes `public accounts:write`, **no refresh token** |
| `GET /v1/mcp/oauth/authorize` | - | PKCE `code_challenge`, loopback `redirect_uri`, `state` | 302 to Gusto consent |
| `POST /v1/provision` | needs `system_access` token | `{user{first_name,last_name,email,phone}, company{name,trade_name,ein,number_employees,states[],addresses[{street_1,street_2,city,state,zip,phone,is_primary}],bank_account{account_number,routing_number,account_type}}}` - sent **unwrapped**; the server re-wraps under `provision` via `wrap_params_in_root` (wrapping client-side double-nests it) | `201 {account_claim_url}` |
| `POST /oauth/revoke` | RFC 7009 | `token` (+ client creds via Basic auth) | 200 |
| `GET /v1/token_info` | - | bearer token | identity + scopes |

**Hard constraints from the server:**
- `client_type=cli` DCR registrations **must** use loopback redirect URIs (`http://localhost`, `http://127.0.0.1`, `http://[::1]`). The validator rejects anything else, so a local callback server is mandatory.
- **Loopback port floats; path must match.** At authorize time the server matches the runtime callback URL against the registered URI via `RedirectUriAllowlist.loopback_match?`, which compares scheme/host/path/query/fragment and **excludes the port** (`loopback_parts`). The token exchange does not re-validate `redirect_uri` at all. So we register one fixed-path loopback URI (`http://127.0.0.1/callback`) and bind an ephemeral port at login - but the callback **path** used at runtime must equal the registered path.
- `system_access` tokens carry **no refresh token** (`use_refresh_token: false`) and only `accounts:write`.
- **Device grant is not available for `cli`.** The MCP token handler's `SUPPORTED_GRANT_TYPES` is `[authorization_code, refresh_token, system_access]` - no `device_code`. zenpayroll has device-grant routes, but they aren't wired to the MCP/DCR path. Loopback PKCE is the only sanctioned login transport (see Auth transport below).
- `/oauth/revoke` is the **root partner** Doorkeeper endpoint, not part of the MCP/DCR surface. The MCP flow has no revoke bridge. Whether `/oauth/revoke` accepts a CLI-flow token authenticated with DCR client creds is **unproven** - logout treats revoke as best-effort (see below).

## Auth transport and the headless gap

Login is **loopback PKCE** (server-mandated; device grant isn't wired for `cli`). PKCE is inherently interactive: it needs a browser to render Gusto consent and a loopback server on the same host to catch the redirect. Implications:

- **Interactive (default):** open the authorize URL with the OS opener (`open` / `xdg-open`); if that fails, **print the URL for manual paste**. The loopback server captures the code locally either way.
- **Headless / SSH / CI / pure-agent:** there is **no way to complete `login` or provision's Mode 2 without a human + browser reaching the loopback host**. This is a **known V1 limitation**, not a bug. An agent driving the CLI must either run where a browser is reachable, or hand the printed authorize URL to a human on the same machine. `--agent` mode keeps machine-readable output, but it cannot mint a user token unattended.
- **Future fix (out of scope):** a server-side device-grant bridge for `client_type=cli` would close the headless gap. Note it on the epic; not this PR.

Note `system_access` (provision step 1) has **no** interactivity - it's pure client-credentials, so the agent-driven provision *kickoff* works headless; only the post-claim Mode 2 user token needs the browser.

## Architecture

New modules under `src/lib/oauth/`. Each has one responsibility, communicates through a small typed interface, and is unit-testable in isolation.

| Module | Responsibility | Depends on |
|---|---|---|
| `dcr.ts` | First-run client registration. `registerClient(baseUrl) -> {client_id, client_secret}`. | `api-client` |
| `pkce.ts` | `generateVerifier/Challenge`, `buildAuthorizeUrl`, loopback callback server on an ephemeral port, `exchangeCode -> TokenSet`. Shared by `auth login` and provision Mode 2. | `api-client` |
| `system-access.ts` | `mintSystemAccess(clientId, clientSecret) -> TokenSet` (no refresh). | `api-client` |
| `token-store.ts` | `TokenStore` interface (`load/save/clear`) + `FileStore` (0600 `credentials.toml`, keyed by env) + `resolveStore()`. | `config` (paths) |
| `session.ts` | `getValidToken(kind)`: loads from store, refreshes/re-mints as needed. Wraps `ApiClient` so a 401 triggers one recovery attempt + retry. | `token-store`, `pkce`, `system-access` |
| `revoke.ts` | `revokeToken(token, clientCreds)` - best-effort `POST /oauth/revoke`. | `api-client` |

`config.ts` is unchanged in responsibility: it holds **non-secret** prefs (`environment`, `format`). Secrets (`client_id`, `client_secret`, tokens) **never** touch `config.toml` - they go to the `TokenStore`.

## Token storage

A single 0600 file, `~/.config/gusto/credentials.toml` (dir 0700), keyed by environment (`sandbox` / `production`). This matches how the major CLIs store tokens - aws (`~/.aws/credentials`), gcloud (`~/.config/gcloud`), Stripe, Heroku, npm all use plaintext 0600 files; gh uses an OS keyring but falls back to a plaintext file.

**Why not the OS keychain (yet):** a real keychain needs a native binding (gh uses Go's `go-keyring`, which calls the macOS Security framework directly). The `security` CLI can't substitute - it truncates secrets at 128 bytes (`readpassphrase`), and our session blob is larger. A native addon (e.g. `@napi-rs/keyring`) can't be cross-compiled into the `bun build --compile` single binary. So file-at-0600 is the V1 store; a native keychain is a documented future enhancement.

**Stored fields** (per env): `client_id`, `client_secret`, `access_token`, `refresh_token`, `expires_at`, `company_uuid`. These are the **user** (Mode 2) token plus DCR creds.

**The `system_access` token is never stored.** It has no refresh token, is short-lived, and is minted on demand from the stored client creds for the single `/v1/provision` call, then discarded. Only the DCR `client_id`/`client_secret` persist; the system token itself is request-scoped.

Tokens are **single-company** (strict access, per AINT-561). Multi-company users re-OAuth per company; we do not store multiple company token sets in V1. **Consequence:** the store holds one active token set per env, so logging into / provisioning a second company **overwrites** the first company's token. This is intended for the V1 wedge; multi-company storage is explicitly out of scope.

## Flows

### `auth login`
1. If no `client_id`/`client_secret` in store: run DCR, persist creds.
2. PKCE: generate verifier/challenge and a random `state`, start loopback callback server on an ephemeral port, open the authorize URL in the browser.
3. Capture `code` on the callback, **reject a mismatched `state`**, exchange for a user `TokenSet` (access + refresh), persist.
4. Call `GET /v1/token_info`; read identity from it, and when `resource.type == "Company"` store `resource.uuid` as the `company_uuid` so later commands resolve it without `--company-uuid`. Print the identity.

> Topology: the PKCE redirect is two hops. The CLI opens `/v1/mcp/oauth/authorize`, which 302s to the real Gusto consent screen; after consent Gusto hits the MCP `oauth/callback`, which redirects to the CLI's loopback `redirect_uri` with the MCP authorization `code`. The `code_verifier` is validated by the MCP token handler at `/v1/mcp/oauth/token`.

### `auth whoami`
Existing `/v1/token_info` call, switched to read the stored token instead of `GUSTO_ACCESS_TOKEN`/`--token` (env/flag still override).

### `auth logout`
1. Best-effort `POST /oauth/revoke` with the stored access token + DCR client creds.
2. Any non-2xx is non-fatal: log a warning, continue.
3. Always clear the local store for the active env.
4. If there's no stored session (e.g. the user only ever used `GUSTO_ACCESS_TOKEN`/`--token`), logout is a clean no-op - nothing to revoke with, nothing to clear.

> Follow-up (not this PR): if guaranteed revocation is needed, add a `/v1/mcp/oauth/revoke` bridge server-side that translates DCR creds the way `register`/`token` do. File under AINT-562 or a new server ticket. I'll record the actual sandbox behavior during implementation.

### `company provision` (auth test driver)

**Scope note:** here `provision` exists to drive the `system_access` -> `/v1/provision` -> claim -> Mode 2 chain end-to-end so we can prove auth works. The ergonomic input surface (interactive prompts, per-field flags, rich validation) is **deferred to the AINT-562 PR**. Input is taken two ways, **mutually exclusive**:

- `--input <file.json>` - a `{user, company}` payload matching the provision contract, or
- `--example` - the scaffold's canned fixture for a zero-arg smoke run (never merged field-wise with real input, so fixture bank/EIN data can't leak into a real provision).

**PII note:** a `--input` file holds EIN and bank routing/account numbers. The CLI reads it and does not persist or scrub it - it's the operator's file. Sensitive values are never accepted as per-field CLI flags (would land in shell history / `ps`); that's another reason per-field flags wait for AINT-562.

Flow:
1. DCR if needed.
2. Mint `system_access` token from stored client creds.
3. `POST /v1/provision` with the `{user, company}` body -> `201 {account_claim_url}`.
4. Open `account_claim_url` in the browser (or print it on opener failure); prompt the user to finish the claim, then continue on their confirmation (e.g. press Enter).
5. Run PKCE Mode 2 for the company-scoped user token. This is the gate: the login only succeeds once the account is claimed, so a pre-claim attempt surfaces a clear auth error rather than a silent hang. Persist the token (sets `company_uuid`).
6. Return the company id.

Honors the scaffold's global flags: `--dry-run` (emit request shape, send nothing), `--example`, `--agent` (stable JSON).

## Two 401 strategies

- **User token** (login, whoami, provision Mode 2): refresh-on-401 -> retry once. On refresh failure, drop the token + prompt re-login.
- **System token** (provision step 2): no refresh token exists, so on 401 **re-mint** from stored client creds (cheap client-credentials round-trip), then retry once.

`session.ts` owns this branching so commands stay unaware of token mechanics. **`getValidToken` is the single authority:** for the **user token** it proactively refreshes when the stored `expires_at` is within a small skew window (e.g. 60s); the **system token** has no stored `expires_at` (it isn't persisted), so it's simply minted fresh per provision run and re-minted on 401. The 401 path is the **fallback** for tokens the server invalidated early (revocation, expiry drift) - at most one recovery attempt + retry, then a typed error. Proactive and reactive paths never both fire for the same request.

## Error handling

- Reuse the scaffold's `handle-api-error.ts` -> `CommandResult` mapping and `ExitCode` enum (`Auth`, `Validation`, `General`).
- DCR failure, browser-open failure (print the URL for manual paste), callback timeout (bounded wait, clear error), refresh/re-mint failure all map to typed `CommandResult` errors - never raw throws to the user.
- `--dry-run` short-circuits before any token is required, matching existing `api-context.ts` behavior.

## Testing

Follow the scaffold's `*.test.ts` + `src/lib/test-support.ts` patterns.

- `pkce`: verifier/challenge correctness; authorize URL params; callback server captures code + rejects bad `state`.
- `token-store`: file round-trip + 0600 perms; one env doesn't clobber another; absent file returns null.
- `system-access`: mint request shape; no-refresh handling.
- `session`: 401 -> refresh -> retry; 401 -> re-mint -> retry; failure -> re-login prompt.
- `dcr`: loopback redirect URI in the request body.
- `revoke`: non-2xx is non-fatal; store still cleared.
- Command-level: `auth login`/`logout`/`whoami`; `company provision` dry-run shape; `--input` vs `--example` are mutually exclusive (error if both).
- `auth login` reads `company_uuid` from `token_info` `resource.uuid` (when `resource.type == "Company"`) and stores it; mismatched `state` is rejected.
- Manual e2e against sandbox: login round-trip + provision happy path (gated on a local `GUSTO_CLI_CLIENT_ID`).

## Preconditions / flags

1. **#344183 (AINT-554) must merge first** - server-side grant the client consumes.
2. **`GUSTO_CLI_CLIENT_ID` set locally** in zenpayroll (`CONFIG__MCP__CLI__CLIENT_ID` or local SOPS) or cli flows return `server_error`. Per AINT-553/561 notes; the Panda partner apps already exist across envs.
3. **AINT-558** (sec review of `/v1/provision` + write scopes) gates *shipping* the provision path to V1 - target review before 6/12. Writing the code is fine; enabling it is not yet cleared.
4. Logout's `/oauth/revoke` behavior with DCR creds is unproven - verified during implementation against sandbox.

## Out of scope / YAGNI

- **`company status` / `show` / `finish`** - the rest of AINT-562. Read/navigation commands with no new auth surface; ship in the AINT-562 PR. (Note for that PR: `show`'s serializer returns `name`/`trade_name`/`filing_address` but not EIN/entity type - reconcile against the ticket; `status` returns `onboarding_steps`, from which `blocked_on` is synthesized; `finish` should treat `PUT finish_onboarding`'s nested errors as authoritative rather than only a client pre-check.)
- **`provision` input ergonomics** - interactive prompts, per-field flags, rich validation (AINT-562 PR). This PR ships only `--input <file.json>` / `--example`.
- Multi-company token storage (re-OAuth instead).
- A proper MCP-layer revoke bridge (server-side follow-up).
- **Device-grant / headless login** - needs a server-side device bridge for `cli`; note on the epic, not this PR.
- **Native OS keychain** - the secure-at-rest store (what gh does via a native binding). Needs `@napi-rs/keyring` or `bun:ffi` to `SecItem`/libsecret, which means reworking the `bun build --compile` distribution. Future enhancement; 0600 file ships V1.
- Encrypted file storage beyond 0600 perms.
- Concurrency: two CLI processes racing on the store (e.g. simultaneous refresh) is not guarded. Last-write-wins is acceptable for the wedge.
