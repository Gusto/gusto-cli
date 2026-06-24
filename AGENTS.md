# Working with the gusto CLI (for agents)

Discover commands with `--help`, not by reading files in this repo:

```sh
gusto --help              # top-level commands
gusto <command> --help    # flags and usage for a command, e.g. gusto employee --help
```

`--help` is generated from the CLI itself, so it's always accurate and lists every flag. Don't infer command shape from `README.md` or other docs - they can drift, and reading them costs tokens you don't need to spend.

## Installing the CLI

The user might ask you to install the CLI. The canonical path is the installer - it pulls the notarized binary for the user's OS/arch from the latest GitHub Release, verifies its SHA256, drops it at `~/.gusto/bin/gusto`, and adds that dir to `PATH` if it isn't there:

```sh
curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh
```

After it runs, `~/.gusto/bin` may not be on the current shell's `PATH` yet - source the rc file (`. ~/.zshrc` or `. ~/.bashrc`) or `export PATH="$HOME/.gusto/bin:$PATH"` so the rest of the session works. Verify with `gusto --help`.

## Conventions worth knowing

- **`--agent` / `--json`** emits a stable JSON envelope on stdout: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": {...} }`. It's auto-on when stdout is piped, so you usually get JSON for free.
- **`--dry-run`** on any create command prints the request body it would send, without sending it. Use it to preview the shape before committing.
- **Missing required args** return a `blocked_on` envelope (exit code `7`) listing the fields to retry with. Exit codes are defined in `src/lib/exit-codes.ts`.
- **Auth** resolves explicit-first: a token piped to `--token-stdin`, then `GUSTO_ACCESS_TOKEN`, then a stored login session (`gusto auth login`). An explicit token wins even when it's invalid - you get the real auth error rather than a silent fall back to the session's identity. `GUSTO_COMPANY_UUID` (or `--company-uuid`) sets the company. `--env sandbox` is the default; `--env production` hits prod.

## Driving `auth login` as the agent

Two paths depending on whether the user already has a demo company they can sign into:

- **No existing demo company:** `gusto company provision` creates one and returns an `account_claim_url`. Surface that URL to the user so they can claim it in their browser, then run `gusto auth login --no-browser`. The CLI mints and stores an OAuth token bound to the new company.
- **Existing admin access:** `gusto auth login --no-browser` direct.

Always pass `--no-browser` when *you* (the agent) are running `auth login`. It prints the sign-in URL on stderr instead of trying to `open` a browser from your shell - you surface that URL to the user, who completes sign-in in a browser running on the same machine. The OAuth callback hits `127.0.0.1`, so the user has to be on the same host as the CLI.

## Bundled skills

`gusto skill list` shows the skills this CLI can install into a project's agent workspace; `gusto skill install <name>` installs one. `gusto auth login` will also offer to auto-install bundled skills the first time it runs. The `onboard-company` skill drives a full company onboarding (read `~/.claude/skills/onboard-company/SKILL.md` after install for the steps and pause points).
