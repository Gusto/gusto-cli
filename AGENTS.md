# Working with the gusto CLI (for agents)

Discover commands with `--help`. Don't infer them from this file or `README.md` - those can drift.

```sh
gusto --help              # top-level commands
gusto <command> --help    # flags and usage for any subcommand
```

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh
```

Pulls the notarized binary for the user's OS/arch from the latest GitHub Release, verifies SHA256, installs to `~/.gusto/bin/gusto`, and updates `PATH`. If the current shell doesn't see `gusto` yet, source the rc file or `export PATH="$HOME/.gusto/bin:$PATH"`. Then `gusto --help` to verify.

## Conventions

- **`--agent` / `--json`** emits a stable JSON envelope: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": {...} }`. Auto-on when stdout is piped.
- **`--dry-run`** on any create command prints the request body without sending.
- **Missing required args** return a `blocked_on` envelope (exit code `7`) listing the fields to retry with. Exit codes live in `src/lib/exit-codes.ts`.
- **Auth precedence:** `--token-stdin` > `GUSTO_ACCESS_TOKEN` > stored session (`gusto auth login`). An explicit token always wins so a bad secret surfaces the real auth error rather than silently running as the logged-in identity. `GUSTO_COMPANY_UUID` (or `--company-uuid`) sets the company.
- **Environment:** `--env sandbox` (default) hits demo; `--env production` hits prod.

## Driving `auth login`

Two paths:

- **No demo company yet:** `gusto company provision` returns an `account_claim_url`. Surface it to the user, then run `gusto auth login`.
- **Existing admin access on demo:** `gusto auth login` direct.

`auth login` auto-detects browser capability - opens one when there's a usable GUI session (a real `BROWSER`, `DISPLAY`/`WAYLAND_DISPLAY` on Linux, a logged-in macOS/Windows session), prints the sign-in URL on stderr otherwise (CI, headless boxes, SSH without X forwarding). Surface whatever it prints. Pass `--no-browser` only to force print-only.

The OAuth callback hits `127.0.0.1`, so the user signs in on the same host as the CLI.

## Bundled skills

`gusto skill list` shows what's available; `gusto skill install <name>` installs one into the project's agent workspace. `gusto auth login` offers to auto-install bundled skills on first sign-in. The `onboard-company` skill drives a full company onboarding - read `~/.claude/skills/onboard-company/SKILL.md` after install for the steps and pause points.
