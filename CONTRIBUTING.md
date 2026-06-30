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
- Sign off every commit (see [Developer Certificate of Origin](#developer-certificate-of-origin))

## Developer Certificate of Origin

By contributing you certify the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) for your contribution. In short: you wrote the code, or otherwise have the right to submit it under this project's license.

Certify it by signing off each commit. `bun install` wires up a `prepare-commit-msg` hook that auto-appends the trailer from your git `user.name` / `user.email`, so plain `git commit` is enough once you've installed deps. If you skipped the install or want to be explicit:

```sh
git commit -s        # appends a Signed-off-by line from your git user.name/user.email
```

The trailer looks like:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Use your real name and an email you can be reached at. CI rejects PRs whose commits aren't signed off. To fix commits you already made:

```sh
git commit --amend -s            # the most recent commit
git rebase --signoff origin/main # every commit on your branch
```

The hook lives in [`.githooks/prepare-commit-msg`](.githooks/prepare-commit-msg) and is wired in by [`scripts/install-hooks.sh`](scripts/install-hooks.sh), which `postinstall` runs after `bun install`. If you cloned with `--ignore-scripts` or want to set it up by hand:

```sh
sh scripts/install-hooks.sh
```

<details>
<summary>Full DCO text (v1.1)</summary>

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.

Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

</details>

## Pull requests

PRs require:
- Green CI (typecheck, lint, unit tests, smoke tests, cross-platform build)
- A DCO sign-off on every commit (see above)
- Code-owner review (`@Gusto/ai-interfaces`)
- Updates to tests when behavior changes
