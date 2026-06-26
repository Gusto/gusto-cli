# Gusto CLI

Agent-friendly developer interface for Gusto payroll. From `curl | sh` to onboarded payroll in a single chat session with an agent.

> **Status: v0.0.1.** The command surface is stable. Config, skill bundling, and the REST commands are implemented and callable today. OAuth login (`gusto auth login`) and `gusto company provision` are live, along with the `gusto company` onboarding surface - `onboarding-status`, `setup <federal-tax|state-tax|bank-account|pay-schedule>`, and `forms`.

> **Driving this with an agent?** Point it at [`AGENTS.md`](AGENTS.md) (raw: <https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/AGENTS.md>) - it covers install, `auth login`, and the conventions. `gusto --help` / `gusto <command> --help` is the authoritative command surface.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh | sh
```

> A `cli.gusto.com` shortcut isn't set up yet, so the installer pulls the script directly from GitHub.

This detects your OS/arch, downloads the matching binary from the latest GitHub Release, verifies its SHA256, and installs to `~/.gusto/bin/gusto` (no sudo). If that dir isn't on your `PATH`, it adds a line to your shell profile (`.zshrc`/`.bashrc`/`.profile`). Set `GUSTO_CLI_VERSION` to pin a release or `GUSTO_INSTALL_DIR` to install elsewhere.

New binaries are published to GitHub Releases on each `v*.*.*` tag (see `.github/workflows/release.yml`).

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

`--env sandbox` (default) hits `https://api.gusto-demo.com`. `--env production` hits `https://api.gusto.com`. `GUSTO_API_BASE_URL` overrides both for testing.

## Quickstart

```sh
gusto --help
gusto auth whoami          # confirm the token works
gusto employee list        # company-scoped read
gusto employee add --first-name Jane --last-name Doe --email jane@example.com
gusto skill install onboard-company
```

The commands above are examples. `gusto --help` lists every top-level command and `gusto <command> --help` lists its flags - that's the authoritative command surface (and what agents should reach for first), since this README can drift.

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

The CLI ships bundled skills - `onboard-company` (drives a full company onboarding) and `cash-forecasting` (projects upcoming payroll cash needs). Install one into a project's agent workspace:

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

MIT - see [LICENSE](LICENSE).
