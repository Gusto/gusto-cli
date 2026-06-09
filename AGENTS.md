# Working with the gusto CLI (for agents)

Discover commands with `--help`, not by reading files in this repo:

```sh
gusto --help              # top-level commands
gusto <command> --help    # flags and usage for a command, e.g. gusto employee --help
```

`--help` is generated from the CLI itself, so it's always accurate and lists every flag. Don't infer command shape from `README.md` or other docs - they can drift, and reading them costs tokens you don't need to spend.

## Conventions worth knowing

- **`--agent` / `--json`** emits a stable JSON envelope on stdout: `{ "ok": true, "data": {...} }` or `{ "ok": false, "error": {...} }`. It's auto-on when stdout is piped, so you usually get JSON for free.
- **`--dry-run`** on any create command prints the request body it would send, without sending it. Use it to preview the shape before committing.
- **Missing required args** return a `blocked_on` envelope (exit code `7`) listing the fields to retry with. Exit codes are defined in `src/lib/exit-codes.ts`.
- **Auth** comes from `GUSTO_ACCESS_TOKEN` + `GUSTO_COMPANY_UUID` (or `--token` / `--company-uuid`). `--env sandbox` is the default.

## Bundled skills

`gusto skill list` shows the skills this CLI can install into a project's agent workspace; `gusto skill install <name>` installs one. The `onboard-company` skill drives a full company onboarding.
