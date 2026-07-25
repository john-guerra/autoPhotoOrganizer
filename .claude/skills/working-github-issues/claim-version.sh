#!/usr/bin/env bash
# Atomically claim the next version number, so two agents working in parallel
# can never ship the same `x.y.z`.
#
# The lock is a remote git tag `claim/<version>`. Creating a remote ref is the
# only true compare-and-swap GitHub offers: the second pusher gets
# `! [rejected] (already exists)` and a non-zero exit. Labels, comments and
# issue edits are all last-write-wins and cannot be used for this.
#
# Usage:
#   claim-version.sh <issue-number>            # patch bump (the default)
#   claim-version.sh <issue-number> --minor    # cutting a packaged build
#
# Prints the claimed version on stdout. Release it after merge with:
#   git push origin :refs/tags/claim/<version>

set -euo pipefail

ISSUE="${1:?usage: claim-version.sh <issue-number> [--minor]}"
MODE="${2:---patch}"
WHO="${CLAUDE_SESSION_ID:-$(hostname -s)-$$}"
BRANCH="$(git branch --show-current 2>/dev/null || echo detached)"

git fetch -q origin main

# Versions already claimed by other agents. `ls-remote` returns annotated tags
# TWICE -- `claim/2.18.8` and the peeled `claim/2.18.8^{}` -- so strip `^{}`
# before doing any math, or every claim counts double.
claimed() {
  git ls-remote --tags origin 'refs/tags/claim/*' 2>/dev/null \
    | sed -e 's#.*refs/tags/claim/##' -e 's#\^{}$##' \
    | sort -u
}

base_version() {
  git show origin/main:package.json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))"
}

bump() { # bump <version> <--patch|--minor>
  local IFS=. ; read -r a b c <<<"$1"
  if [ "$2" = "--minor" ]; then echo "$a.$((b + 1)).0"; else echo "$a.$b.$((c + 1))"; fi
}

# Start above BOTH what main ships and what every live claim holds, so a claim
# is never lower than a version already spoken for.
HIGHEST="$( { base_version; claimed; } \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 )"
CANDIDATE="$(bump "$HIGHEST" "$MODE")"

for _ in 1 2 3 4 5; do
  git tag -d "claim/$CANDIDATE" >/dev/null 2>&1 || true
  if git tag -a "claim/$CANDIDATE" -m "issue:$ISSUE session:$WHO branch:$BRANCH" 2>/dev/null &&
    git push -q origin "refs/tags/claim/$CANDIDATE" 2>/dev/null; then
    echo "$CANDIDATE"
    exit 0
  fi
  # Lost the race -- someone claimed it between our read and our push. Drop the
  # local tag and try the next number up. NEVER --force: that steals a live claim.
  git tag -d "claim/$CANDIDATE" >/dev/null 2>&1 || true
  CANDIDATE="$(bump "$CANDIDATE" --patch)"
done

echo "claim-version: lost 5 races in a row -- is something looping?" >&2
exit 1
