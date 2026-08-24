#!/usr/bin/env bash
# Shared foreground runner for tdai-reflect (session-end reflection capture).
#
# Both entrypoints delegate here so env loading, identity resolution, the
# unbound-project guard and the audit log live in exactly one place:
#   - tdai-reflect-hook.sh      (Claude Code SessionEnd, detached)
#   - .opencode/plugins/…       (OpenCode session.idle, awaited by the plugin)
#
# Usage:
#   tdai-reflect-run.sh <transcript> <session-id> <cwd> [format] [extra reflect args...]
#
# Foreground on purpose: the caller decides whether to detach (nohup … &) or
# await the result. Reflect stdout goes to our stdout; diagnostics and the
# audit header go to $LOG_FILE. Exit code mirrors tdai-reflect.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DEPLOY_DIR/../.." && pwd)"
REFLECT_BIN="$REPO_ROOT/MemoryMCP/bin/tdai-reflect.mjs"
LOG_FILE="$DEPLOY_DIR/.reflect.log"

[[ $# -ge 3 ]] || { echo "usage: tdai-reflect-run.sh <transcript> <session-id> <cwd> [format] [extra args...]" >&2; exit 2; }
TRANSCRIPT="$1"
SESSION_ID="$2"
SESSION_CWD="$3"
FORMAT="${4:-claude-code}"
shift 4 2>/dev/null || shift 3

find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for p in /usr/local/bin/node /opt/homebrew/bin/node; do
    [[ -x "$p" ]] && { echo "$p"; return; }
  done
  return 1
}
NODE="$(find_node)" || exit 0
[[ -f "$REFLECT_BIN" ]] || exit 0
[[ -n "$TRANSCRIPT" && -f "$TRANSCRIPT" ]] || exit 0

# Capture telemetry is emitted only by this already-detached runner. The
# SessionEnd hook never calls the network synchronously.
RUN_ID="$("$NODE" -e 'process.stdout.write(require("node:crypto").randomUUID())')"

now_iso() {
  "$NODE" -e 'process.stdout.write(new Date().toISOString())'
}

emit_event() {
  local event_name="$1"
  local event_seq="$2"
  local occurred_at="$3"
  local status="$4"
  local written_count="$5"
  local kind_counts="$6"
  local error_stage="$7"
  local payload
  payload="$("$NODE" -e '
    const [event, seq, runId, sessionId, source, agentId, teamId, route, model, at, status, written, kinds, errorStage] = process.argv.slice(1);
    let kindCounts = {};
    try { kindCounts = JSON.parse(kinds || "{}"); } catch {}
    process.stdout.write(JSON.stringify({
      event,
      event_seq: Number(seq),
      run_id: runId,
      session_id: sessionId,
      source,
      agent_id: agentId || null,
      team_id: teamId || null,
      route,
      model: model || null,
      occurred_at: at,
      status,
      written_count: Number(written) || 0,
      kind_counts: kindCounts,
      error_stage: errorStage || null,
    }));
  ' "$event_name" "$event_seq" "$RUN_ID" "$SESSION_ID" "$FORMAT" "$EVENT_AGENT_ID" "$EVENT_TEAM_ID" "$ROUTE" "${TDAI_REFLECT_LLM_MODEL:-}" "$occurred_at" "$status" "$written_count" "$kind_counts" "$error_stage")"
  curl --max-time 2 -sS -o /dev/null -X POST "${PANEL_URL%/}/api/v1/capture/events" \
    -H "Authorization: Bearer ${PANEL_API_KEY}" \
    -H "x-tdai-service-id: ${TDAI_SERVICE_ID:-default}" \
    -H 'Content-Type: application/json' \
    --data-raw "$payload" >/dev/null 2>&1 &
}

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

PANEL_URL="${TDAI_PANEL_URL:-http://127.0.0.1:8125}"
PANEL_API_KEY="${TDAI_PANEL_API_KEY:-local}"
EVENT_AGENT_ID=""
EVENT_TEAM_ID="${TDAI_TEAM_ID:-}"

# Per-project write identity — shared resolution with the stdio MCP wrapper
# (../_identity.sh: .tdai-project.env → folder-name registry match → default)
# shellcheck disable=SC1091
source "$DEPLOY_DIR/_identity.sh"
resolve_project_identity "$SESSION_CWD"
ROUTE="$TDAI_IDENTITY_ROUTE"
if [[ "${TDAI_IDENTITY_BOUND:-0}" == "1" ]]; then
  EVENT_AGENT_ID="${TDAI_AGENT_ID:-}"
fi

emit_event started 1 "$(now_iso)" running 0 '{}' ''

# Unbound project: refuse rather than file another project's lessons.
if [[ "${TDAI_IDENTITY_BOUND:-0}" != "1" && "${TDAI_ALLOW_DEFAULT_IDENTITY:-0}" != "1" ]]; then
  {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] session=$SESSION_ID route=$ROUTE cwd=$SESSION_CWD"
    if [[ -n "${TDAI_IDENTITY_INVALID:-}" ]]; then
      echo "  refused: agent ${TDAI_AGENT_ID:-?} is ${TDAI_IDENTITY_INVALID} on the Panel; a write would be accepted and then unreadable."
      echo "  fix: correct TDAI_AGENT_ID in .tdai-project.env, or re-activate the agent on the Panel."
    else
      echo "  refused: project is not bound to an agent; not writing to the machine default (${TDAI_AGENT_ID:-?})."
      echo "  bind it: create a Panel agent named '$(basename "$SESSION_CWD")', or write TDAI_AGENT_ID=agt-… to .tdai-project.env at the project root."
    fi
  } >> "$LOG_FILE" 2>&1
  emit_event finished 2 "$(now_iso)" refused_unbound 0 '{}' identity
  exit 0
fi

# Local models (LM Studio) can take well over the 60s default on long
# transcripts; a timed-out extraction silently loses the session's lessons.
export TDAI_REFLECT_TIMEOUT_MS="${TDAI_REFLECT_TIMEOUT_MS:-240000}"

# Review-only mode: extract and log proposed lessons without writing them to
# memory. Intended for auditing a weak local reflect model before trusting it.
DRY_RUN_FLAG=()
case "$(printf '%s' "${TDAI_REFLECT_DRY_RUN:-}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes) DRY_RUN_FLAG=(--dry-run) ;;
esac

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] session=$SESSION_ID agent=${TDAI_AGENT_ID:-?} route=$ROUTE format=$FORMAT model=${TDAI_REFLECT_LLM_MODEL:-?}${DRY_RUN_FLAG:+ mode=dry-run} transcript=$TRANSCRIPT"
} >> "$LOG_FILE" 2>&1

REFLECT_OUTPUT="$("$NODE" "$REFLECT_BIN" --transcript "$TRANSCRIPT" --format "$FORMAT" --session-id "$SESSION_ID" ${DRY_RUN_FLAG[@]+"${DRY_RUN_FLAG[@]}"} "$@")"
REFLECT_EXIT=$?
printf '%s\n' "$REFLECT_OUTPUT"

SUMMARY_JSON="$(printf '%s\n' "$REFLECT_OUTPUT" | tail -n 1)"
SUMMARY_META="$($NODE -e '
  try {
    const summary = JSON.parse(process.argv[1] || "{}");
    const counts = { adr: 0, preference: 0, constraint: 0, other: 0 };
    for (const lesson of Array.isArray(summary.lessons) ? summary.lessons : []) {
      const kind = lesson && typeof lesson.kind === "string" ? lesson.kind : "other";
      counts[kind === "adr" || kind === "preference" || kind === "constraint" ? kind : "other"] += 1;
    }
    const statuses = new Set(["written", "empty", "skipped", "dry-run"]);
    const status = statuses.has(summary.status) ? summary.status : "";
    const written = Number.isInteger(summary.written) && summary.written >= 0 ? summary.written : 0;
    process.stdout.write(JSON.stringify({ status, written, counts }));
  } catch {}
' "$SUMMARY_JSON" 2>/dev/null || true)"

FINAL_STATUS="error"
WRITTEN_COUNT=0
KIND_COUNTS='{}'
ERROR_STAGE=""
if [[ "$REFLECT_EXIT" -eq 0 && -n "$SUMMARY_META" ]]; then
  FINAL_STATUS="$($NODE -e 'try{process.stdout.write(JSON.parse(process.argv[1]).status||"")}catch{}' "$SUMMARY_META")"
  WRITTEN_COUNT="$($NODE -e 'try{process.stdout.write(String(JSON.parse(process.argv[1]).written||0))}catch{process.stdout.write("0")}' "$SUMMARY_META")"
  KIND_COUNTS="$($NODE -e 'try{process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).counts||{}))}catch{process.stdout.write("{}")}' "$SUMMARY_META")"
  [[ -n "$FINAL_STATUS" ]] || FINAL_STATUS="error"
else
  case "$REFLECT_EXIT" in
    2) ERROR_STAGE="config" ;;
    3) ERROR_STAGE="transcript" ;;
    4) ERROR_STAGE="llm" ;;
    5) ERROR_STAGE="write" ;;
    *) ERROR_STAGE="runner" ;;
  esac
fi
emit_event finished 2 "$(now_iso)" "$FINAL_STATUS" "$WRITTEN_COUNT" "$KIND_COUNTS" "$ERROR_STAGE"
exit "$REFLECT_EXIT"
