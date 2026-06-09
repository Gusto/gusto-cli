# Security

If you find a security issue in the Gusto CLI, please do not open a public issue. Email `security@gusto.com` with a description and reproduction steps. We will acknowledge within two business days.

## Scope

In scope:
- The CLI binary and bundled skills
- The install script at `raw.githubusercontent.com/Gusto/gusto-cli-public/main/install.sh` (until `cli.gusto.com` is set up)
- The OAuth flows the CLI participates in (DCR, PKCE)

Out of scope:
- Gusto product UI bugs (report at gusto.com/security)
- Issues in upstream dependencies without a Gusto-specific exploit path
