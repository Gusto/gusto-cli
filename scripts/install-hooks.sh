#!/bin/sh
set -eu

if [ -n "${BUN_INSTALL_CACHE_DIR:-}" ] && [ ! -d ".git" ] && [ ! -f ".git" ]; then
  exit 0
fi

git rev-parse --git-dir >/dev/null 2>&1 || exit 0

current=$(git config --local --get core.hooksPath 2>/dev/null || true)
if [ "$current" = ".githooks" ]; then
  exit 0
fi

if [ -n "$current" ]; then
  echo "core.hooksPath is already set to '$current'; leaving it untouched. Run 'git config --local core.hooksPath .githooks' to enable DCO auto sign-off." >&2
  exit 0
fi

git config --local core.hooksPath .githooks
echo "configured core.hooksPath=.githooks for DCO auto sign-off"
