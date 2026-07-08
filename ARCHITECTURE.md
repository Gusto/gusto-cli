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

- **`lib/api-client.ts`** — `fetch`-based HTTP client. Adds `Authorization`, `X-Gusto-API-Version`. Retries 5xx and network errors on `GET`/`DELETE` only (POST/PUT are not retried to avoid double-creates). `AbortSignal.timeout` enforces a per-attempt timeout.
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
  };
}
```

- Agent mode prints one JSON object per command, terminated by `\n`. No banners, no progress bars.
- Human mode prints data with `JSON.stringify(..., 2)` or a string when scalar, and errors to stderr.

## Auth

`gusto auth login` runs an OAuth flow (Dynamic Client Registration + PKCE) and stores the resulting session. An explicitly supplied token takes precedence over that session - `--token-stdin` > `GUSTO_ACCESS_TOKEN` > the stored session - so a bad explicit token surfaces a real auth error rather than silently falling back to the logged-in identity. See `lib/oauth/` for the login flow and `lib/api-context.ts` for resolution precedence.

## Adding a command

1. Add `src/commands/<noun>.ts` with a `register<Noun>Command(parent: Command)` function.
2. Each subcommand calls `runCommand("<name>", readGlobalFlags(parent.opts()), handler(opts))`.
3. Handler returns a `CommandResult` — never throws past the runner.
4. Wire it up in `src/index.ts`.
5. Add a smoke case in `tests/smoke.test.ts` and unit tests next to any new lib code.
