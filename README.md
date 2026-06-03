# Gusto CLI

Agent-friendly developer interface for Gusto payroll. From `curl | sh` to onboarded payroll in a single chat session with an agent.

> **Status: V0.0.1.** Command surface is locked. Config, skill bundling, and most REST commands are implemented and callable today against a sandbox API token. OAuth login (`gusto auth login`), `gusto company provision`, and `gusto company finish` are deferred to AINT-561 and AINT-562. See the [shape spec](https://www.notion.so/36ead673c6c281efacd0c2e2c533f9f7) and the [V1 sprint epic AINT-552](https://gustohq.atlassian.net/browse/AINT-552).

> **Repo name:** currently `gusto-cli-public` because `Gusto/gusto-cli` is taken by an unrelated internal engineering CLI (`gdev-eng`). Once that collision is resolved, this repo will move to `Gusto/gusto-cli`.

## Install

```sh
curl -fsSL https://cli.gusto.com/install.sh | sh
```

(Install path lands with [AINT-560](https://gustohq.atlassian.net/browse/AINT-560).)

## Authentication

Until `gusto auth login` lands (AINT-561), pass an access token explicitly:

```sh
export GUSTO_ACCESS_TOKEN="..."
export GUSTO_COMPANY_UUID="..."
gusto employee list
```

Or per-invocation:

```sh
gusto employee list --token <token> --company-uuid <uuid>
```

`--env sandbox` (default) hits `https://api.gusto-demo.com`. `--env production` hits `https://api.gusto.com`. `GUSTO_API_BASE_URL` overrides both for testing.

## Quickstart

```sh
gusto --help
gusto auth whoami          # confirm the token works
gusto employee list        # company-scoped read
gusto employee add --first-name Jane --last-name Doe --email jane@example.com
gusto skill install onboard-company
```

`gusto <any-create-command> --dry-run` builds the request body from your args and prints it without sending. Useful for agent introspection and for previewing the request shape before committing.

Missing required arguments return a structured `blocked_on` envelope (exit 7) so agents can retry with the missing fields, e.g.:

```json
{
  "ok": false,
  "error": {
    "code": "validation",
    "message": "missing required arguments",
    "blocked_on": [{ "field": "email", "reason": "required" }]
  }
}
```

## Output

Dual surface, single contract:

- `--human` (default on TTY): tables, key-value blocks, short status lines
- `--agent` (default when stdout is piped) / `--json`: stable JSON envelope on stdout

Every command emits the same envelope shape:

```json
{ "ok": true, "data": { ... } }
{ "ok": false, "error": { "code": "...", "message": "...", "blocked_on": [...] } }
```

Exit codes are documented in [`src/lib/exit-codes.ts`](src/lib/exit-codes.ts): `0` success, `1` general, `2` CLI usage, `3` auth, `4` API 4xx, `5` API 5xx, `6` network, `7` validation, `8` blocked state.

## Bundled skills

V0.0.1 ships one bundled skill, `onboard-company`. Install it into a project's agent workspace:

```sh
gusto skill list
gusto skill install onboard-company
```

The install command walks up the cwd looking for `.claude/skills`, `.cursor/skills`, or `.windsurf/skills`. Falls back to `~/.claude/skills`. For `.claude` targets, the SKILL.md frontmatter gets `user-invocable: true` so the skill appears as a slash command in Claude Code.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, architecture, and conventions.

```sh
bun install
bun run dev -- --help
bun run build
bun run test:all
```

## Stack

- [Bun](https://bun.sh) + TypeScript, compiled to a single binary per OS/arch via `bun build --compile`
- [Commander.js](https://github.com/tj/commander.js) for noun-verb command parsing
- [smol-toml](https://github.com/squirrelchat/smol-toml) for `~/.config/gusto/config.toml`
- [ESLint](https://eslint.org) + [Prettier](https://prettier.io) for lint + format
- Bun's built-in test runner

## License

MIT - see [LICENSE](LICENSE).
