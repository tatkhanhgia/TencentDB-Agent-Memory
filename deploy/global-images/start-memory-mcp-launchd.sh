#!/usr/bin/env bash
# Foreground launcher for launchd (com.tdai.memory-mcp.plist).
# Unlike start-memory-mcp.sh this does NOT daemonize — launchd owns the
# process lifecycle (KeepAlive restarts it on crash).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCP_MAIN="$REPO_ROOT/MemoryMCP/bin/tdai-memory-mcp.mjs"

ENV_FILE="$SCRIPT_DIR/.mcp.env"
[[ -f "$ENV_FILE" ]] || { echo "[memory-mcp-launchd] $ENV_FILE missing" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${TDAI_API_KEY:-}" && -s "$SCRIPT_DIR/.admin-key" ]]; then
  TDAI_API_KEY="$(cat "$SCRIPT_DIR/.admin-key")"
  export TDAI_API_KEY
fi
# Bindings live only in .mcp.bindings.json (device tokens → identity lists).
BINDINGS_FILE="$SCRIPT_DIR/.mcp.bindings.json"
[[ -f "$BINDINGS_FILE" ]] || { echo "[memory-mcp-launchd] $BINDINGS_FILE missing — run start-memory-mcp.sh once to bootstrap it" >&2; exit 1; }
TDAI_MCP_BINDINGS="$(cat "$BINDINGS_FILE")"
export TDAI_MCP_BINDINGS
export TDAI_MCP_HTTP_PORT="${TDAI_MCP_HTTP_PORT:-8425}"
export TDAI_MCP_HTTP_HOST="${TDAI_MCP_HTTP_HOST:-127.0.0.1}"

# launchd has a minimal PATH; resolve node explicitly.
for p in /usr/local/bin/node /opt/homebrew/bin/node; do
  [[ -x "$p" ]] && exec "$p" "$MCP_MAIN"
done
command -v node >/dev/null 2>&1 && exec node "$MCP_MAIN"
echo "[memory-mcp-launchd] node not found" >&2
exit 1
