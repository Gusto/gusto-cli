#!/usr/bin/env bash
# Verify every commit in BASE..HEAD carries a Developer Certificate of Origin
# sign-off (`Signed-off-by`) matching its author. Bot authors are exempt.
# Fails closed: a missing range or a git error aborts the job rather than
# passing silently. See CONTRIBUTING.md#developer-certificate-of-origin.
set -euo pipefail

if [ -z "${BASE:-}" ] || [ -z "${HEAD:-}" ]; then
  echo "::error::Could not determine the PR commit range (BASE/HEAD empty)."
  exit 1
fi

# Materialize the list first: reading rev-list via process substitution runs it
# in a subshell and swallows its exit code, so a bad ref would let the gate pass
# silently. A failure here aborts the job instead.
commits=$(git rev-list --no-merges "$BASE..$HEAD")
if [ -z "$commits" ]; then
  echo "::error::No commits found in $BASE..$HEAD."
  exit 1
fi

fail=0
while IFS= read -r sha; do
  subject=$(git show -s --format='%s' "$sha")
  author=$(git show -s --format='%ae' "$sha")
  # Bots (dependabot, github-actions) don't sign off; their PRs are exempt.
  case "$author" in
    *"[bot]@"* | *"bot@users.noreply.github.com") echo "skip bot: ${sha:0:8} $subject"; continue ;;
  esac
  # Capture (not pipe) so a git failure aborts under set -e instead of masking
  # as a missing sign-off; grep only sees a successful read.
  signoffs=$(git show -s --format='%(trailers:key=Signed-off-by,valueonly=true)' "$sha")
  if printf '%s\n' "$signoffs" | grep -qiF "<$author>"; then
    echo "ok: ${sha:0:8} $subject"
  else
    echo "MISSING DCO sign-off matching author <$author>: ${sha:0:8} $subject"
    fail=1
  fi
done <<< "$commits"

if [ "$fail" -ne 0 ]; then
  echo "::error::One or more commits lack a Signed-off-by line matching the commit author. Run 'git rebase --signoff $BASE' and force-push. See CONTRIBUTING.md#developer-certificate-of-origin."
  exit 1
fi
