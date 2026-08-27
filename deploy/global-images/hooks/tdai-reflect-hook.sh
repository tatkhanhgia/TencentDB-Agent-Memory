#!/usr/bin/env bash
# Claude Code SessionEnd hook → tdai-reflect (session-end reflection capture).
#
# Receives the hook payload JSON on stdin ({session_id, transcript_path, ...}),
# then runs tdai-reflect DETACHED so session shutdown is never blocked.
# Always exits 0 — reflection is best-effort and must not break the harness.
# All real work lives in tdai-reflect-run.sh (shared with the OpenCode plugin).
#
# Wire-up (~/.claude/settings.json or project .claude/settings.json):
#   {"hooks": {"SessionEnd": [{"hooks": [{"type": "command",
#     "command": "<repo>/deploy/global-images/hooks/tdai-reflect-hook.sh"}]}]}}
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$DEPLOY_DIR/.reflect.log"

PAYLOAD="$(cat || true)"
[[ -n "$PAYLOAD" ]] || exit 0

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for p in /usr/local/bin/node /opt/homebrew/bin/node; do
    [[ -x "$p" ]] && { echo "$p"; return; }
  done
  return 1
}
NODE="$(find_node)" || exit 0

read_field() {
  printf '%s' "$PAYLOAD" | "$NODE" -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(String(JSON.parse(d).$1??''))}catch{}})"
}

TRANSCRIPT="$(read_field transcript_path)"
SESSION_ID="$(read_field session_id)"
SESSION_CWD="$(read_field cwd)"
[[ -n "$TRANSCRIPT" && -n "$SESSION_ID" && -n "$SESSION_CWD" ]] || exit 0

{
  nohup "$SCRIPT_DIR/tdai-reflect-run.sh" \
    "$TRANSCRIPT" "$SESSION_ID" "$SESSION_CWD" claude-code \
    >> "$LOG_FILE" 2>&1 &
} 2>/dev/null

exit 0
