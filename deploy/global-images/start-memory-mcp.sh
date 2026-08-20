#!/usr/bin/env bash
# Start MemoryMCP in Streamable HTTP mode as a host process (not a container —
# it needs the local MemoryMCP build and only serves loopback by default).
#
# Usage:
#   ./start-memory-mcp.sh          # start (idempotent: restarts if running)
#   ./start-memory-mcp.sh --status # health probe only
#
# Endpoint for harnesses:  http://127.0.0.1:8425/mcp
# Auth: Authorization: Bearer <device token from .mcp.bindings.json>.
#       Every token maps server-side to a LIST of identities; the session
#       picks one (elicitation / tdai_identity_use, or "default"). The Core
#       API key never leaves this machine's server side.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCP_MAIN="$REPO_ROOT/MemoryMCP/bin/tdai-memory-mcp.mjs"
MCP_ENV_FILE="$SCRIPT_DIR/.mcp.env"
PID_FILE="$SCRIPT_DIR/.memory-mcp.pid"
LOG_FILE="$SCRIPT_DIR/.memory-mcp.log"

[[ -f "$MCP_ENV_FILE" ]] || die ".mcp.env 不存在。先 cp .mcp.env.example .mcp.env 并填好 identity。"
set -a
# shellcheck disable=SC1090
source "$MCP_ENV_FILE"
set +a

MCP_PORT="${TDAI_MCP_HTTP_PORT:-8425}"
MCP_HOST="${TDAI_MCP_HTTP_HOST:-127.0.0.1}"

probe() {
  # No public health endpoint: an unauthenticated POST /mcp returning 401
  # proves the server is up and enforcing auth.
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST -H "Content-Type: application/json" -d '{}' \
    "http://${MCP_HOST}:${MCP_PORT}/mcp" 2>/dev/null || echo "000")
  [[ "$code" == "401" ]]
}

if [[ "${1:-}" == "--status" ]]; then
  if probe; then ok "memory-mcp HTTP 已就绪: http://${MCP_HOST}:${MCP_PORT}/mcp"; exit 0
  else die "memory-mcp 未运行或不健康（port ${MCP_PORT}）"; fi
fi

# API key fallback: admin key from start-memory-core.sh
if [[ -z "${TDAI_API_KEY:-}" ]]; then
  [[ -s "$SCRIPT_DIR/.admin-key" ]] || die "TDAI_API_KEY 为空且 .admin-key 不存在。先启动 memory-core。"
  TDAI_API_KEY="$(cat "$SCRIPT_DIR/.admin-key")"
  export TDAI_API_KEY
fi
require_vars TDAI_ENDPOINT TDAI_SERVICE_ID TDAI_TEAM_ID TDAI_AGENT_ID TDAI_USER_ID

# Bindings live ONLY in .mcp.bindings.json: token → {identities: [...], default?}.
# Single-token mode (TDAI_MCP_TOKEN in .mcp.env, hard-bound to one identity)
# was removed — coding harnesses serve many projects, so every token is a
# device token that lists identities and the session picks one.
# First run: bootstrap one device token in registry mode — the identity list
# resolves live from the Panel agent registry, so creating an agent in the
# web UI is enough for it to appear in the harness picker (no manual sync).
BINDINGS_FILE="$SCRIPT_DIR/.mcp.bindings.json"
if [[ ! -f "$BINDINGS_FILE" ]]; then
  BOOT_TOKEN="tok-$(openssl rand -hex 16)"
  cat > "$BINDINGS_FILE" <<EOF
{
  "_comment": "Device token bindings. identities: \"registry\" resolves the list live from the Panel agent registry (create an agent in the web UI -> it appears in the picker). Replace with a static identities:[...] array to pin the list. suggested preselects the picker choice; default skips the question entirely.",
  "${BOOT_TOKEN}": {
    "identities": "registry"
  }
}
EOF
  chmod 600 "$BINDINGS_FILE"
  info "已生成 .mcp.bindings.json（device token: ${BOOT_TOKEN}，registry 模式）"
fi
TDAI_MCP_BINDINGS="$(node -e '
  const fs = require("fs");
  const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.error(".mcp.bindings.json must be a JSON object of token -> binding");
    process.exit(1);
  }
  const tokens = Object.keys(raw).filter((k) => !k.startsWith("_"));
  if (tokens.length === 0) {
    console.error(".mcp.bindings.json declares no tokens");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(raw));
' "$BINDINGS_FILE")" || die ".mcp.bindings.json 解析失败"
export TDAI_MCP_BINDINGS
FIRST_TOKEN="$(node -e '
  const raw = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(Object.keys(raw).find((k) => !k.startsWith("_")) ?? "");
' "$BINDINGS_FILE")"
info "已加载 .mcp.bindings.json（$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(Object.keys(r).filter(k=>!k.startsWith("_")).length)' "$BINDINGS_FILE") device token）"
export TDAI_MCP_HTTP_PORT="$MCP_PORT"
export TDAI_MCP_HTTP_HOST="$MCP_HOST"

[[ -f "$MCP_MAIN" ]] || die "$MCP_MAIN 不存在。先 cd MemoryMCP && npm install && npm run build"
command -v node >/dev/null 2>&1 || die "node 不可用（需要 >= 20）"

# Idempotent restart
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    info "停止旧 memory-mcp 进程 (pid $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 1; done
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# 防并发/孤儿进程：kill 旧 pid 后端口仍被占用说明有别的进程在听，直接终止
if lsof -iTCP:"$MCP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "端口 ${MCP_PORT} 仍被占用（非 pid 文件记录的进程）。lsof -iTCP:${MCP_PORT} 查明后再启动。"
fi

info "启动 memory-mcp (Streamable HTTP) → http://${MCP_HOST}:${MCP_PORT}/mcp"
nohup node "$MCP_MAIN" >> "$LOG_FILE" 2>&1 &
MCP_PID=$!
echo "$MCP_PID" > "$PID_FILE"

for _ in $(seq 1 15); do
  if probe; then
    ok "memory-mcp 就绪 (pid $MCP_PID)"
    echo ""
    echo "  ┌─ 任意 MCP harness 连接方式 ────────────────────────────────────┐"
    echo "  │  URL:    http://${MCP_HOST}:${MCP_PORT}/mcp"
    echo "  │  Header: Authorization: Bearer ${FIRST_TOKEN}"
    echo "  │  stdio 备选: $SCRIPT_DIR/tdai-memory-mcp.sh"
    echo "  │  示例配置: MemoryMCP/examples/"
    echo "  └────────────────────────────────────────────────────────────────┘"
    exit 0
  fi
  kill -0 "$MCP_PID" 2>/dev/null || { warn "进程已退出，日志尾部："; tail -n 30 "$LOG_FILE" >&2; die "memory-mcp 启动失败"; }
  sleep 1
done
warn "等待超时，日志尾部："
tail -n 30 "$LOG_FILE" >&2
die "memory-mcp 在 15s 内未就绪"
