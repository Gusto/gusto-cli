# Contributing

The Gusto CLI is a 3-week wedge experiment. See the [shape spec](https://www.notion.so/36ead673c6c281efacd0c2e2c533f9f7) for the design contract V1 is locking in.

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
bun run lint                 # biome check
bun run lint:fix             # biome --write
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

## Build

```sh
bun run build            # local host arch
bun run build:all        # macOS arm64 + macOS x86_64 + Linux x86_64
```

`bun build --compile` produces a single-file binary with the Bun runtime bundled. No Node install required on the host.

## Commit style

- Single-line summary, 20-80 chars, imperative mood
- Reference the Jira ticket: `[AINT-XXX] do the thing`
- Body explains why if non-obvious; otherwise leave it terse

## Pull requests

PRs require:
- Green CI (typecheck, lint, unit tests, smoke tests, cross-platform build)
- Code-owner review (`@Gusto/ai-interfaces`)
- Updates to tests when behavior changes
