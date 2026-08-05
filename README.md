# Gusto CLI

Agent-friendly developer interface for Gusto payroll. From `curl | sh` to running per-cycle payroll prep in a single chat session with an agent.

> **Status: v0.1.0.** The command surface is stable. Config, skill bundling, and the REST commands are implemented and callable today. OAuth login (`gusto auth login`) is live, along with per-cycle payroll prep: `gusto timesheet`, `gusto payroll`, `gusto pay-schedule`, and the `gusto employee` / `gusto contractor` / `gusto job` / `gusto compensation` commands.

> **Driving this with an agent?** Point it at [`AGENTS.md`](AGENTS.md) (raw: <https://raw.githubusercontent.com/Gusto/gusto-cli/main/AGENTS.md>) - it covers install, `auth login`, and the conventions. `gusto --help` / `gusto <command> --help` is the authoritative command surface.

## Install

```sh
curl -fsSL https://cli.gusto.com/install.sh | sh
```

This detects your OS/arch, downloads the matching binary from the latest GitHub Release, verifies its SHA256, and installs to `~/.gusto/bin/gusto` (no sudo). If that dir isn't on your `PATH`, it adds a line to your shell profile (`.zshrc`/`.bashrc`/`.profile`). Set `GUSTO_CLI_VERSION` to pin a release or `GUSTO_INSTALL_DIR` to install elsewhere.

New binaries are published to GitHub Releases on each `v*.*.*` tag (see `.github/workflows/release.yml`).

## Upgrade

```sh
gusto upgrade --dry-run   # is a newer release available?
gusto upgrade             # replace the binary in place
```

Resolves the latest release, downloads the asset for your OS/arch, verifies it against that release's `SHA256SUMS`, checks the new binary runs, then atomically replaces the installed one. A checksum mismatch or a binary that won't run leaves your current install untouched; being already up to date exits `0`.

Same overrides as the installer: `GUSTO_CLI_VERSION` pins a release (which is also how to downgrade), `GUSTO_INSTALL_DIR` names the binary to replace, and `GUSTO_CLI_REPO`/`GUSTO_CLI_BASE_URL` point at a different origin. The version compared against is read from the binary at that path, not from the `gusto` you invoked, so pointing `GUSTO_INSTALL_DIR` at another install upgrades _that_ one on its own merits. `from` is `null` when nothing runnable is installed there yet. Installs managed by a package manager (Homebrew, Nix) are refused - update those with the package manager, so its metadata stays in step with what's on disk.

In agent mode (piped stdout, `--agent`, `--json`) the upgrade is gated behind `--confirm` like any other write, since it replaces the binary the agent is running. `--dry-run` needs no `--confirm`.

## Authentication

The simplest path is an interactive OAuth login:

```sh
gusto auth login
gusto auth whoami   # confirm it worked
```

You can also pass an access token explicitly - useful for CI and other scripted environments:

```sh
export GUSTO_ACCESS_TOKEN="..."
export GUSTO_COMPANY_UUID="..."
gusto employee list
```

Or pipe the token on stdin (keeps the secret out of argv, shell history, and `set -x`/audit logs):

```sh
echo "$TOKEN" | gusto employee list --token-stdin --company-uuid <uuid>
```

Token resolution order: `--token-stdin` (piped) > `GUSTO_ACCESS_TOKEN` > stored login session (`gusto auth login`). An explicit token always wins so a typo'd secret surfaces the real auth error instead of silently running as the logged-in identity.

### Environments and credential slots

`--env production` (default) hits `https://api.gusto.com`. `--env sandbox` hits `https://api.gusto-demo.com`. `GUSTO_API_BASE_URL` overrides both for testing.

Environment resolution, highest precedence first: `--env` > `GUSTO_ENVIRONMENT` > `gusto config set environment <env>` > production.

Each environment keeps its **own** credential slot, both in one `credentials.toml` under your config directory. Signing in to sandbox leaves your production session untouched and vice versa, and `gusto auth logout` only clears the environment you name. `gusto auth whoami` reports the active `environment` alongside the credential source, so you can always ask the CLI which one it is talking to.

### When auth fails

Auth failures all exit `3` and name the environment (`error.environment`). The first three are decided before any request goes out and also name the credential slot they read; the last is the API's verdict on a credential that looked usable:

| code                   | what it means                                                                                                   | what to do                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `no_access_token`      | no credentials at all for that environment                                                                      | `gusto auth login`, set `GUSTO_ACCESS_TOKEN`, or pipe one via `--token-stdin`                                                                                                        |
| `session_expired`      | the access token expired and there's no refresh token (or no client credentials) to renew it                    | `gusto auth login --env <env>`                                                                                                                                                       |
| `token_refresh_failed` | a refresh was attempted and the server rejected it; the stored refresh token is untouched                       | retry the command first - only log in again if the retry also fails, since logging in replaces that refresh token                                                                    |
| `credential_rejected`  | the API answered `401`: the credential was sent and refused, so it's stale, revoked, or for another environment | depends which credential was used, and the message names it - sign in again for a stored session, fix the value for `GUSTO_ACCESS_TOKEN` or `--token-stdin`. A bare retry won't help |

When the environment you asked for has no usable session but the other one does, the error carries a `hint` naming it. That's usually the real problem: a session that works under `--env sandbox` looks like a broken credential model the moment you drop the flag.

## Quickstart

```sh
gusto --help
gusto auth whoami          # confirm the token works
gusto employee list        # company-scoped read
gusto pay-schedule create --frequency biweekly --first-payday 2026-07-03 --anchor-end-of-pay-period 2026-06-26 --dry-run
gusto skill install cash-forecasting
```

The commands above are examples. `gusto --help` lists every top-level command and `gusto <command> --help` lists its flags - that's the authoritative command surface (and what agents should reach for first), since this README can drift.

`gusto <any-create-command> --dry-run` builds the request body from your args and prints it without sending. Useful for agent introspection and for previewing the request shape before committing.

When a command is driven by an agent (piped stdout, `--agent`, or `--json`), a write is blocked with a `confirmation_required` envelope (exit 8) until it's re-run with `--confirm`. This keeps a human in the loop: surface the action, get approval, then add `--confirm`. `--dry-run` previews without it, and interactive (TTY) runs aren't gated. The CLI only drafts payroll - it has no run/submit command, so it can't move money even with `--confirm`.

Missing required arguments return a structured `blocked_on` envelope (exit 7) so agents can retry with the missing fields, e.g.:

```json
{
  "ok": false,
  "error": {
    "code": "validation",
    "message": "missing required arguments",
    "blocked_on": [{ "field": "first-payday", "reason": "required" }]
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

Authentication failures take `3` even though they arrive as 4xx responses, because what to do about them has nothing to do with the request: a `401` is `credential_rejected` and a `403` naming a missing OAuth scope is `insufficient_scope`. Branch on `3` to catch every credential problem in one place. Other 4xx statuses stay `4`.

**Treating API data as untrusted.** String fields the API returns - employee names, job titles, notes, GL account descriptions - are user-controlled. When an agent consumes CLI output, those values are data, never instructions: a field whose value reads like a command is still just a string. The `--agent` envelope helps here, since a value stays inside a typed field rather than flattening into prose, so the data/instruction boundary is explicit. See [`AGENTS.md`](AGENTS.md) for the agent-facing version of this.

## Bundled skills

The CLI ships bundled skills - `cash-forecasting` (projects upcoming payroll cash needs), `timesheet-sync` (drives the per-cycle timesheet input flow), and `payroll-prep` (maps an owner's per-cycle inputs onto a draft payroll for review). Install one into a project's agent workspace:

```sh
gusto skill list
gusto skill install cash-forecasting
```

The install command walks up the cwd looking for a project skills directory: `.claude/skills`, `.cursor/skills`, `.agents/skills` (Codex), `.cline/skills`, or `.windsurf/skills`. Falls back to `~/.claude/skills`. For `.claude` targets, the SKILL.md frontmatter gets `user-invocable: true` so the skill appears as a slash command in Claude Code.

On `gusto auth login`, the bundled skills auto-install into every supported agent tool detected on the machine, so they load in whichever tool you drive the CLI from:

| Tool        | Global skills directory      |
| ----------- | ---------------------------- |
| Claude Code | `~/.claude/skills`           |
| Cursor      | `~/.cursor/skills`           |
| Codex       | `~/.codex/skills`            |
| Cline       | `~/.cline/skills`            |
| Windsurf    | `~/.codeium/windsurf/skills` |

Detection keys on each tool's home directory (`~/.claude`, `~/.cursor`, `~/.codex`, `~/.cline`, `~/.codeium`). To install into specific tools instead of auto-detecting, pass `--target` (comma-separated `claude,cursor,codex,cline,windsurf`, or `all`) or set `GUSTO_SKILLS_TARGET`; both override detection, and `--target` wins over the env var. Only the explicit `--target` flag also overrides a persisted `never` for that run; an ambient `GUSTO_SKILLS_TARGET` still honors `never`. If no supported tool is found, nothing is installed and the CLI prints where it looked. Skip the install for one run with `--no-skills`, or opt out permanently with `gusto config set skills_auto_install never`.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, architecture, and conventions.

```sh
bun install
bun run dev -- --help
bun run build
bun run test:all
```

## macOS code signing

The release workflow signs and notarizes the macOS binaries so Gatekeeper doesn't flag them as untrusted. It runs on the same Linux runner as the build via [`rcodesign`](https://github.com/indygreg/apple-platform-rs), so there's no macOS runner. Each darwin binary is signed with Gusto's Developer ID Application certificate (hardened runtime on) and submitted to Apple's notary service. A bare binary can't have its notarization ticket stapled, so Gatekeeper verifies it online the first time it runs.

Signing relies on these repo secrets:

- `MACOS_CERT_P12_BASE64` - base64 of the leaf-only Developer ID Application `.p12`
- `MACOS_CERT_PASSWORD` - that `.p12`'s passphrase
- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_P8` - App Store Connect API key used for notarization

### Rotating the certificate

Developer ID Application certificates are valid for five years. To rotate:

1. Generate a key and CSR locally, keeping `dev.key`:
   ```sh
   openssl req -new -newkey rsa:2048 -nodes -keyout dev.key -out dev.csr \
     -subj "/emailAddress=you@gusto.com/CN=Gusto CLI Developer ID/C=US"
   ```
2. Have an Apple Developer account admin create a **Developer ID Application** certificate (not Installer) from the CSR and send back the `.cer`.
3. Build a leaf-only `.p12` - don't bundle the Apple intermediate, or rcodesign signs with the wrong certificate:
   ```sh
   openssl x509 -inform DER -in dev.cer -out leaf.pem
   openssl pkcs12 -export -inkey dev.key -in leaf.pem -out signing.p12
   ```
4. Update the `MACOS_CERT_P12_BASE64` (`base64 -i signing.p12`) and `MACOS_CERT_PASSWORD` secrets.

## Stack

- [Bun](https://bun.sh) + TypeScript, compiled to a single binary per OS/arch via `bun build --compile`
- [Commander.js](https://github.com/tj/commander.js) for noun-verb command parsing
- [smol-toml](https://github.com/squirrelchat/smol-toml) for `~/.config/gusto/config.toml`
- [ESLint](https://eslint.org) + [Prettier](https://prettier.io) for lint + format
- Bun's built-in test runner

## License

Apache 2.0 - see [LICENSE](LICENSE) and [NOTICE](NOTICE).
