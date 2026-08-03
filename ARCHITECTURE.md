# Architecture

A one-page map of the CLI so a new contributor can find their way around in under five minutes.

## Goals

- **Agent-first**: every command emits a JSON envelope by default when piped, falling back to human-readable text in a TTY.
- **Predictable exit codes**: agents and shell scripts branch on numeric exit codes, not stderr scraping.
- **Thin wrapper over the Gusto API**: the CLI does not own business logic. It validates input, calls the API, and shapes the response for the caller.

## Layout

```
src/
  index.ts            entry point: builds the commander program, wires global flags, registers commands
  commands/           one file per top-level noun (employee, company, contractor, ...)
  lib/                shared plumbing: api client, output, runner, env, exit codes
  skills/             prompt-side helpers loaded by agents via `gusto skill ...`
  types/              shared TypeScript types
tests/
  smoke.test.ts       end-to-end smoke against `bun run src/index.ts`
```

Tests for each `lib/` module live next to it as `<name>.test.ts`.

## Request flow

```
user CLI invocation
  -> commander parses argv
  -> command handler in src/commands/*.ts
       -> resolveApiContext()    resolves the access token + --company-uuid (stdin / env / session)
       -> validates required fields (returns Validation exit code with blocked_on envelope)
       -> ApiClient.{get,post,put,delete}()
            -> retries 5xx + network errors on idempotent verbs (GET/DELETE)
            -> times out at 30s by default
       -> toResult() on error    shapes ApiError / NetworkError into the agent envelope
  -> runner.runCommand() emits the envelope + sets process exit code
```

## Key modules

- **`lib/api-client.ts`** — `fetch`-based HTTP client. Adds `Authorization`, `X-Gusto-API-Version`, `User-Agent`. Retries 5xx and network errors on `GET`/`DELETE` only (POST/PUT are not retried to avoid double-creates). `AbortSignal.timeout` enforces a per-attempt timeout.
- **`lib/version.ts`** — the one place the CLI's version is declared. Exports `VERSION` (read from `package.json`, what `gusto --version` prints) and `USER_AGENT`.
- **`lib/upgrade.ts`** — the self-update path behind `gusto upgrade` (`commands/upgrade.ts` is just commander wiring). Re-implements `install.sh`'s contract in TypeScript: same `gusto-$os-$arch` asset names, same `SHA256SUMS` verification, same `GUSTO_CLI_VERSION` / `GUSTO_CLI_REPO` / `GUSTO_CLI_BASE_URL` / `GUSTO_INSTALL_DIR` overrides, including `mkdir -p` on the install dir and the refusal to follow a redirect off https. Resolves the target version from GitHub's `/releases/latest` redirect rather than `api.github.com`, so the lookup needs no auth and has no rate limit. Everything that can fail cheaply (path resolution, dir writability, version lookup, whether the staging path is usable) runs before the first byte is fetched; the download is checksummed before it is written at all, then staged inside the install dir under an `O_EXCL` create, exec-checked, and swapped in with a single `rename(2)`. Every wait has a deadline, so a stalled connection or a build that hangs on init can't leave the command hanging with no envelope.
- **`lib/handle-api-error.ts`** — converts thrown `ApiError`/`NetworkError` into a `CommandResult` with the right exit code and, for API errors, surfaces the raw response body in `error.details` and the request id in `error.request_id`.
- **`lib/output.ts`** — `AgentEnvelope` shape (`{ ok, data?, error? }`) and the agent-vs-human emit logic. The `--agent` / `--human` / `--json` flags resolve to a single `OutputMode`.
- **`lib/runner.ts`** — wraps every command handler so exceptions can't leak past the envelope. Centralizes exit code propagation.
- **`lib/exit-codes.ts`** — the only place exit codes are defined. See the table in README.
- **`lib/api-context.ts`** — resolves the access token (`--token-stdin` > `GUSTO_ACCESS_TOKEN` > stored login session) and the company UUID (`--company-uuid` > `GUSTO_COMPANY_UUID` > the login session's bound company). An explicit token always wins, so a bad one surfaces a real auth error instead of silently falling back to the session. Returns either a usable context or a Validation result with `blocked_on`.

## Output contract

Every command produces an `AgentEnvelope`:

```ts
{
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    blocked_on?: { field, reason }[];   // missing/invalid inputs the agent can retry
    details?: unknown;                    // raw upstream API body
    request_id?: string;                  // upstream X-Request-Id for support
    hint?: string;                        // recovery pointer: the way out of *this* failure
  };
}
```

`hint` is a recovery path, not a general remark, and it is per-failure rather than per-command: `commands/upgrade.ts` offers the installer only for the failures it would actually route around, and something else for the ones it wouldn't. A hint that can't work costs more than no hint, since an agent will follow it - so attach one only where you know it resolves the failure at hand.

- Agent mode prints one JSON object per command, terminated by `\n`. No banners, no progress bars.
- Human mode prints data with `JSON.stringify(..., 2)` or a string when scalar, and errors to stderr.

## User-Agent

Every outbound request carries:

```
User-Agent: gusto-cli/<version> (<os>-<arch>)      e.g. gusto-cli/0.1.0 (darwin-arm64)
```

**This format is a stable contract.** Version-adoption reporting groups on it, so changing the grammar - adding a field, reordering, appending free text - silently splits one release across buckets and breaks historical comparisons. Treat it like a wire format: extend only additively and only deliberately.

- `<version>` is `VERSION` from `lib/version.ts`, the same value `gusto --version` prints. The release workflow rejects a tag that disagrees with `package.json`, so the two cannot drift.
- `<os>-<arch>` come from `process.platform`/`process.arch` and use the same tokens as the published binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`).
- No locale-, clock-, or environment-dependent fields: two runs of the same build on the same machine always produce the identical string.
- Attached in `ApiClient.sendOnce` (covers every command, MCP tool call, retry, and paginated page) and in the OAuth `send` helper (covers the legs that can't use `ApiClient` because they aren't bearer-authenticated: client registration, code exchange, token refresh). Login's `token_info` check is bearer-authenticated and goes through `ApiClient`, so it's covered by the first path.

## Auth

`gusto auth login` runs an OAuth flow (Dynamic Client Registration + PKCE) and stores the resulting session. An explicitly supplied token takes precedence over that session - `--token-stdin` > `GUSTO_ACCESS_TOKEN` > the stored session - so a bad explicit token surfaces a real auth error rather than silently falling back to the logged-in identity. See `lib/oauth/` for the login flow and `lib/api-context.ts` for resolution precedence.

## Adding a command

1. Add `src/commands/<noun>.ts` with a `register<Noun>Command(parent: Command)` function.
2. Each subcommand calls `runCommand("<name>", readGlobalFlags(parent.opts()), handler(opts))`.
3. Handler returns a `CommandResult` — never throws past the runner.
4. Wire it up in `src/index.ts`.
5. Add a smoke case in `tests/smoke.test.ts` and unit tests next to any new lib code.
