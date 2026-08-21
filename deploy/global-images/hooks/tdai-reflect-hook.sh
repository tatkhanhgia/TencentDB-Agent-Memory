#!/usr/bin/env bash
# Claude Code SessionEnd hook → tdai-reflect (session-end reflection capture).
#
# Receives the hook payload JSON on stdin ({session_id, transcript_path, ...}),
# then runs tdai-reflect DETACHED so session shutdown is never blocked.
# Always exits 0 — reflection is best-effort and must not break the harness.
#
# Wire-up (~/.claude/settings.json or project .claude/settings.json):
#   {"hooks": {"SessionEnd": [{"hooks": [{"type": "command",
#     "command": "<repo>/deploy/global-images/hooks/tdai-reflect-hook.sh"}]}]}}
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"
REFLECT_BIN="$REPO_ROOT/MemoryMCP/bin/tdai-reflect.mjs"
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
[[ -f "$REFLECT_BIN" ]] || exit 0

TRANSCRIPT="$(printf '%s' "$PAYLOAD" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).transcript_path??""))}catch{}})')"
SESSION_ID="$(printf '%s' "$PAYLOAD" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).session_id??""))}catch{}})')"
SESSION_CWD="$(printf '%s' "$PAYLOAD" | "$NODE" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).cwd??""))}catch{}})')"
[[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]] || exit 0

# Identity + reflect LLM config
if [[ -f "$DEPLOY_DIR/.mcp.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOY_DIR/.mcp.env"
  set +a
fi
unset TDAI_MCP_HTTP_PORT TDAI_MCP_HTTP_HOST TDAI_MCP_BINDINGS
if [[ -z "${TDAI_API_KEY:-}" && -s "$DEPLOY_DIR/.admin-key" ]]; then
  TDAI_API_KEY="$(cat "$DEPLOY_DIR/.admin-key")"
  export TDAI_API_KEY
fi
# Reflect LLM fallback → MEMORY_LLM_* from the stack .env (rewrite docker host)
if [[ -z "${TDAI_REFLECT_LLM_BASE_URL:-}" && -f "$DEPLOY_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$DEPLOY_DIR/.env"
  set +a
  export TDAI_REFLECT_LLM_BASE_URL="${MEMORY_LLM_BASE_URL/host.docker.internal/127.0.0.1}"
  export TDAI_REFLECT_LLM_API_KEY="${MEMORY_LLM_API_KEY:-}"
  export TDAI_REFLECT_LLM_MODEL="${MEMORY_LLM_MODEL:-}"
fi

# Per-project write identity — shared resolution with the stdio MCP wrapper
# (../_identity.sh: .tdai-project.env → folder-name registry match → default)
# so the agent a session reads from is the one its lessons are written to.
# shellcheck disable=SC1091
source "$DEPLOY_DIR/_identity.sh"
resolve_project_identity "$SESSION_CWD"
ROUTE="$TDAI_IDENTITY_ROUTE"

# Unbound project: the only agent we could write to is the machine default,
# which belongs to another project. Filing this session's lessons there is
# worse than losing them, so refuse and say how to bind.
if [[ "${TDAI_IDENTITY_BOUND:-0}" != "1" && "${TDAI_ALLOW_DEFAULT_IDENTITY:-0}" != "1" ]]; then
  {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] session=$SESSION_ID route=$ROUTE cwd=$SESSION_CWD"
    if [[ -n "${TDAI_IDENTITY_INVALID:-}" ]]; then
      # Core accepts writes for an unknown agent_id and answers "written", so
      # the lessons would be unreadable forever. Refusing is the honest outcome.
      echo "  refused: agent ${TDAI_AGENT_ID:-?} is ${TDAI_IDENTITY_INVALID} on the Panel; a write would be accepted and then unreadable."
      echo "  fix: correct TDAI_AGENT_ID in .tdai-project.env, or re-activate the agent on the Panel."
    else
      echo "  refused: project is not bound to an agent; not writing to the machine default (${TDAI_AGENT_ID:-?})."
      echo "  bind it: create a Panel agent named '$(basename "$SESSION_CWD")', or write TDAI_AGENT_ID=agt-… to .tdai-project.env at the project root."
    fi
  } >> "$LOG_FILE" 2>&1
  exit 0
fi

# Local models (LM Studio) can take well over the 60s default on long
# transcripts; a timed-out extraction silently loses the session's lessons.
export TDAI_REFLECT_TIMEOUT_MS="${TDAI_REFLECT_TIMEOUT_MS:-240000}"

ARGS=(--transcript "$TRANSCRIPT" --format claude-code)
[[ -n "$SESSION_ID" ]] && ARGS+=(--session-id "$SESSION_ID")

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] session=$SESSION_ID agent=${TDAI_AGENT_ID:-?} route=$ROUTE transcript=$TRANSCRIPT"
  nohup "$NODE" "$REFLECT_BIN" "${ARGS[@]}" >> "$LOG_FILE" 2>&1 &
} >> "$LOG_FILE" 2>&1

exit 0
