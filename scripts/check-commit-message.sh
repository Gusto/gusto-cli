#!/bin/sh
set -eu

file=${1:?commit message file required}
bun run commitlint < "$file"
header=$(sed -n '1p' "$file")
if printf '%s\n' "$header" | grep -Eq '[A-Z][A-Z0-9]+-[0-9]+'; then
  echo "commit subject/scope must not contain an internal ticket key" >&2
  exit 1
fi
