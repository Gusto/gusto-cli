#!/bin/sh
set -eu

REPO="${GUSTO_CLI_REPO:-Gusto/gusto-cli-public}"
VERSION="${GUSTO_CLI_VERSION:-latest}"
if [ -z "${GUSTO_INSTALL_DIR:-}" ] && [ -z "${HOME:-}" ]; then
  echo "gusto: HOME is not set; set GUSTO_INSTALL_DIR or HOME and re-run" >&2
  exit 1
fi
INSTALL_DIR="${GUSTO_INSTALL_DIR:-$HOME/.gusto/bin}"

if [ -n "${GUSTO_CLI_BASE_URL:-}" ]; then
  base="$GUSTO_CLI_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "gusto: unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) echo "gusto: unsupported architecture: $arch" >&2; exit 1 ;;
esac
# Releases ship darwin arm64/x64 and linux x64 only - there's no linux arm64
# binary, so fail clearly here instead of 404ing on the download.
if [ "$os" = "linux" ] && [ "$arch" = "arm64" ]; then
  echo "gusto: unsupported platform: Linux arm64 (supported: macOS arm64/x64, Linux x64)" >&2
  exit 1
fi
asset="gusto-$os-$arch"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --proto-redir blocks an https->http downgrade if a redirect is followed. The
# initial scheme is intentionally unrestricted so GUSTO_CLI_BASE_URL can point at
# http for tests/staging.
fetch() {
  curl -fsSL --retry 3 --proto-redir "=https" "$1" -o "$2"
}
fetch "$base/$asset" "$tmp/gusto"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"

# SHA256SUMS is served from the same origin as the binary, so this catches a
# corrupted or partial download, not a tampered origin - that's HTTPS + GitHub's
# release integrity, and real code-signing is AINT-580.
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/gusto" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/gusto" | awk '{print $1}')
fi
expected=$(awk -v a="$asset" '$2 == a {print $1}' "$tmp/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "gusto: no checksum for $asset in SHA256SUMS" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "gusto: checksum mismatch for $asset (expected $expected, got $actual)" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
mv "$tmp/gusto" "$INSTALL_DIR/gusto"
chmod +x "$INSTALL_DIR/gusto"

# macOS Gatekeeper blocks the unsigned binary on first run. Interim fallback
# until AINT-580 ships real code-signing + notarization: clear the quarantine
# attribute. Best-effort and macOS-only; a no-op elsewhere.
if [ "$os" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/gusto" 2>/dev/null || true
fi

# Verify the binary runs before touching the user's PATH/profile, so a failed
# check doesn't leave a dangling PATH entry pointing at an empty dir.
"$INSTALL_DIR/gusto" --version || {
  rm -f "$INSTALL_DIR/gusto"
  echo "gusto: '$INSTALL_DIR/gusto --version' failed; removed the broken install" >&2
  exit 1
}

# Ensure the install dir is on PATH. Append once to the shell profile if missing.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    if [ -z "${HOME:-}" ]; then
      echo "gusto: add $INSTALL_DIR to your PATH" >&2
      profile=""
    else
      case "${SHELL:-}" in
        */zsh) profile="$HOME/.zshrc" ;;
        */bash) profile="$HOME/.bashrc" ;;
        *) profile="$HOME/.profile" ;;
      esac
    fi
    if [ -n "$profile" ] && ! grep -qsF "export PATH=\"$INSTALL_DIR:" "$profile" 2>/dev/null; then
      # $PATH is intentionally literal here - it must expand in the user's shell, not now.
      # shellcheck disable=SC2016
      printf '\n# Added by gusto-cli install.sh\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >>"$profile"
      echo "gusto: added $INSTALL_DIR to PATH in $profile" >&2
      echo "gusto: restart your shell or run: source $profile" >&2
    fi
    ;;
esac
