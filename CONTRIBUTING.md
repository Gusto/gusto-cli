# Contributing

The Gusto CLI is an agent-friendly developer interface for Gusto payroll. This guide covers local setup, the development loop, and the conventions the project follows.

## Prerequisites

- [Bun](https://bun.sh) 1.3.14 or later
- macOS or Linux (Windows support is post-V1)

## Setup

```sh
bun install
```

## Development loop

```sh
bun run dev -- --help        # run from source
bun run typecheck            # tsc --noEmit
bun run lint                 # eslint
bun run lint:fix             # eslint --fix
bun run format               # prettier --write
bun run test                 # unit tests (fast)
bun run test:smoke           # build binary + smoke tests against it
bun run test:all             # full suite
```

## Architecture

```
src/
  index.ts              # entry point: builds the Commander program, runs main()
  commands/             # one file per top-level entity (company, employee, ...)
  lib/
    runner.ts           # CommandRunner abstraction; all commands flow through runCommand()
    output.ts           # --agent / --human / --json output contract + envelope
    exit-codes.ts       # exit code map (0-8, see spec)
    global-flags.ts     # strict typing for global commander options
tests/
  smoke.test.ts         # spawn the compiled binary, assert on real I/O
```

Every command is a thin shim over a `CommandHandler` that returns a `CommandResult`. The runner handles output mode resolution, envelope shape, and exit codes uniformly.

## Output contract

| Flag | Behavior |
|---|---|
| `--agent` | Emit stable JSON on stdout. Errors emit one JSON line, not human-readable text. |
| `--human` | Emit human-readable output. Default when stdout is a TTY. |
| `--json` | Alias for `--agent` with JSON pinned. |
| `--env <sandbox|production>` | Per-invocation environment override. Also reads `GUSTO_ENVIRONMENT`. |
| `--verbose` | Print request IDs + intermediate state to stderr. |

Mode auto-detects via `process.stdout.isTTY` if no flag is set — piped output gets agent JSON.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | general error |
| 2 | CLI usage error (bad flag, unknown command) |
| 3 | auth error |
| 4 | API 4xx |
| 5 | API 5xx |
| 6 | network error |
| 7 | validation error |
| 8 | blocked state (precondition not met) |

## OAuth scopes

The CLI doesn't request scopes itself — it inherits whatever the public-beta partner OAuth app is granted. Two things track that grant:

- **`src/lib/oauth/required-scopes.ts`** — the canonical minimum set, one entry per scope with the CLI command(s) that exercise it. This is the source of truth and audit trail.
- **The partner OAuth app registration in Panda** — the *authoritative* grant, configured per environment (staging / prod / demo). `required-scopes.ts` is kept in sync with it.

**When a change needs a scope** (a new command, or a command that starts hitting a new endpoint):

1. Add the scope to `REQUIRED_SCOPES` in `required-scopes.ts` **in the same PR**, with an accurate `usedBy`. Removing the last consumer of a scope? Drop it from the list (and add it to `DROPPED_SCOPES` if it should never come back).
2. The actual grant is a separate Panda edit — flag it on the ticket for whoever has partner-app access. It does **not** happen automatically on merge. Note: **prod enforces** scopes; **demo** runs scope assertion in bypass/log mode; confirm **staging** before relying on it.
3. `gusto auth whoami` lists `missing_scopes` (required scopes the token lacks) — the first thing to check when a command returns `insufficient_scope`.

Baseline auth scopes (`public`, `access_token:read`) and the retained `webhook_subscriptions:read/write` platform pair are granted but intentionally **not** enumerated in `required-scopes.ts`; don't treat their absence there as a signal to drop them.

## Build

```sh
bun run build            # local host arch
bun run build:all        # macOS arm64 + macOS x86_64 + Linux x86_64
```

`bun build --compile` produces a single-file binary with the Bun runtime bundled. No Node install required on the host.

## Commit style

- Single-line summary, 20-80 chars, imperative mood
- Reference the related issue when there is one
- Body explains why if non-obvious; otherwise leave it terse

## Pull requests

PRs require:
- Green CI (typecheck, lint, unit tests, smoke tests, cross-platform build)
- Code-owner review (`@Gusto/ai-interfaces`)
- Updates to tests when behavior changes
