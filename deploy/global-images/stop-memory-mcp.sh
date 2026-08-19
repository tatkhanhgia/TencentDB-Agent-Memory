#!/usr/bin/env bash
# Stop the host-process Streamable HTTP MemoryMCP started by start-memory-mcp.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

PID_FILE="$SCRIPT_DIR/.memory-mcp.pid"
if [[ ! -f "$PID_FILE" ]]; then
  info "memory-mcp 未运行（无 pid 文件），跳过"
  exit 0
fi
PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
  info "停止 memory-mcp (pid $PID)"
  kill "$PID" 2>/dev/null || true
  for _ in 1 2 3 4 5; do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  kill -9 "$PID" 2>/dev/null || true
  ok "memory-mcp 已停止"
else
  info "pid $PID 不存在，清理 pid 文件"
fi
rm -f "$PID_FILE"
