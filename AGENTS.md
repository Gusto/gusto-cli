# Working with the gusto CLI (for agents)

Discover commands with `--help`. Don't infer them from this file or `README.md` - those can drift.

```sh
gusto --help              # top-level commands
gusto <command> --help    # flags and usage for any subcommand
```

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli/main/install.sh | sh
```

Pulls the notarized binary for the user's OS/arch from the latest GitHub Release, verifies SHA256, installs to `~/.gusto/bin/gusto`, and updates `PATH`. If the current shell doesn't see `gusto` yet, source the rc file or `export PATH="$HOME/.gusto/bin:$PATH"`. Then `gusto --help` to verify.

## Windows

The `gusto` binary ships for macOS and Linux only. On Windows, run it inside WSL2 - the linux-x64 binary works there unchanged. Do all gusto work (and ideally this whole agent session) from the WSL2 shell, not PowerShell or CMD.

1. From an admin PowerShell: `wsl --install`, then reboot. That gets you WSL2 and Ubuntu.
2. Open the Ubuntu shell and run the install command above from there.
3. Run `gusto` from inside WSL2. If you're driving from Windows native instead, prefix calls with `wsl` (e.g. `wsl gusto employee list`) - but a WSL2 shell is simpler.

During `auth login` (see below), WSL2 usually can't open a browser, so the CLI prints the sign-in URL - open it in your Windows browser. The `127.0.0.1` callback reaches the CLI through WSL2's localhost forwarding, so login still completes.

## Conventions

- **`--agent` / `--json`** emits a stable JSON envelope: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": {...} }`. Auto-on when stdout is piped.
- **Pagination:** `list` commands return one page by default plus an opaque top-level `next` cursor when more results exist. Pass it back via `--cursor <next>`, or use `--all` to fetch every page and `--limit <n>` to cap the total. `next` is absent on the last page.
- **`--dry-run`** on any create command prints the request body without sending.
- **Writes need `--confirm` in agent mode.** A write run by an agent (piped stdout, `--agent`, or `--json`) is blocked with a `confirmation_required` envelope (exit code `8`) instead of executing - this covers `timesheet create`/`sync`, `payroll prepare`/`update`, `pay-schedule create`, and any non-GET `gusto api` call. Surface the action to the person you're working for, get their approval, then re-run the same command with `--confirm`. `--dry-run` previews the request without needing `--confirm`. Don't reflexively add `--confirm` to get past the block - the point is that a human approved this specific write. Interactive (TTY) runs aren't gated; the operator at the keyboard is the approval.
- **No payroll-run command.** The CLI only drafts payroll (`payroll prepare`/`update` populate an unprocessed draft). Submitting/running payroll - the irreversible money movement - happens in the Gusto app, not the CLI. There is no `gusto payroll run`/`submit`, so an agent cannot move money through this tool even with `--confirm`.
- **Missing required args** return a `blocked_on` envelope (exit code `7`) listing the fields to retry with. Exit codes live in `src/lib/exit-codes.ts`.
- **Auth precedence:** `--token-stdin` > `GUSTO_ACCESS_TOKEN` > stored session (`gusto auth login`). An explicit token always wins so a bad secret surfaces the real auth error rather than silently running as the logged-in identity. `GUSTO_COMPANY_UUID` (or `--company-uuid`) sets the company.
- **Environment:** `--env sandbox` (default) hits demo; `--env production` hits prod.

## Driving `auth login`

`gusto auth login` signs into an existing Gusto company you administer - company creation and onboarding happen in Gusto, not the CLI.

`auth login` auto-detects browser capability - opens one when there's a usable GUI session (a real `BROWSER`, `DISPLAY`/`WAYLAND_DISPLAY` on Linux, a logged-in macOS/Windows session), prints the sign-in URL on stderr otherwise (CI, headless boxes, SSH without X forwarding). Surface whatever it prints. Pass `--no-browser` only to force print-only.

The OAuth callback hits `127.0.0.1`, so the user signs in on the same host as the CLI.

## Bundled skills

`gusto skill list` shows what's available; `gusto skill install <name>` installs one into the project's agent workspace. `gusto auth login` offers to auto-install bundled skills on first sign-in. `cash-forecasting` projects upcoming payroll cash needs, `timesheet-sync` drives the per-cycle timesheet input flow, and `payroll-prep` maps an owner's per-cycle inputs (hours, tips, commission, bonus, reimbursement) onto a draft payroll for review.
