#!/usr/bin/env bash
# Resolve a stable, human-readable identifier for the agent running this.
#
# Prints `<label>#<key>` -- e.g. `skill-agent-collaboration#e70a532e`.
#
#   label  what John reads in an issue comment. The conversation's custom title
#          if he renamed it, else Claude Code's auto codename (`snazzy-dancing-
#          petal`, same namespace as the worktree names), else the short id.
#   key    the first 8 chars of the session UUID. NEVER changes, so liveness
#          checks and claim matching key on this. The label is mutable -- John
#          can rename a conversation mid-session -- so it must not be the key.
#
# Usage:  agent-id.sh          -> skill-agent-collaboration#e70a532e
#         agent-id.sh --key    -> e70a532e
#         agent-id.sh --label  -> skill-agent-collaboration

set -uo pipefail

SID="${CLAUDE_CODE_SESSION_ID:-}"
if [ -z "$SID" ]; then
  # Not running under Claude Code (a human shell, CI). Still emit something
  # unique rather than a collision-prone constant.
  echo "shell-$(hostname -s)#$$"
  exit 0
fi

KEY="${SID:0:8}"

# Find this session's transcript. Do NOT derive the path from $PWD: an agent in
# a worktree has a different project dir than the main checkout.
TRANSCRIPT="$(ls -1 "$HOME/.claude/projects/"*/"$SID.jsonl" 2>/dev/null | head -1)"

LABEL=""
if [ -n "$TRANSCRIPT" ] && command -v jq >/dev/null 2>&1; then
  # Last custom title wins -- renaming appends a new record rather than editing.
  LABEL="$(jq -rs 'map(select(.type == "custom-title") | .customTitle)
                   | last // empty' "$TRANSCRIPT" 2>/dev/null)"
  [ -z "$LABEL" ] && LABEL="$(jq -rs 'map(.slug // empty) | last // empty' "$TRANSCRIPT" 2>/dev/null)"
fi

case "${1:-}" in
  --key) echo "$KEY" ;;
  --label) echo "${LABEL:-$KEY}" ;;
  *) echo "${LABEL:-agent}#$KEY" ;;
esac
