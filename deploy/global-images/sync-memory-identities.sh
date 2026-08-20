#!/usr/bin/env bash
# Sync memory identities from the Core agent registry (what the Panel shows)
# into .mcp.bindings.json, so every agent created in the Panel appears in the
# harness identity picker without hand-editing JSON.
#
# Usage:
#   ./sync-memory-identities.sh              # add missing identities, warn on stale
#   ./sync-memory-identities.sh --prune      # also remove identities whose agent is gone/inactive
#   ./sync-memory-identities.sh --no-restart # don't restart memory-mcp after syncing
#
# Rules:
#   - Only ACTIVE agents in the team are synced.
#   - Existing identity entries matching an agent_id are left untouched
#     (your custom names/descriptions win).
#   - "_comment", "default", "suggested" and extra tokens are preserved.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

MCP_ENV_FILE="$SCRIPT_DIR/.mcp.env"
BINDINGS_FILE="$SCRIPT_DIR/.mcp.bindings.json"
PRUNE=0
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --prune) PRUNE=1 ;;
    --no-restart) RESTART=0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

[[ -f "$MCP_ENV_FILE" ]] || die ".mcp.env 不存在"
set -a
# shellcheck disable=SC1090
source "$MCP_ENV_FILE"
set +a
if [[ -z "${TDAI_API_KEY:-}" ]]; then
  [[ -s "$SCRIPT_DIR/.admin-key" ]] || die "TDAI_API_KEY 为空且 .admin-key 不存在"
  TDAI_API_KEY="$(cat "$SCRIPT_DIR/.admin-key")"
fi
require_vars TDAI_ENDPOINT TDAI_TEAM_ID TDAI_USER_ID
[[ -f "$BINDINGS_FILE" ]] || die "$BINDINGS_FILE 不存在。先跑一次 start-memory-mcp.sh 生成。"

AGENTS_JSON="$(curl -sS --max-time 15 -X POST "${TDAI_ENDPOINT%/}/v3/meta/agent/list" \
  -H "Authorization: Bearer local" \
  -H "x-tdai-user-key: ${TDAI_API_KEY}" \
  -H "x-tdai-service-id: ${TDAI_SERVICE_ID:-default}" \
  -H "Content-Type: application/json" \
  -d "{\"team_id\":\"${TDAI_TEAM_ID}\",\"limit\":100}")" || die "agent/list 请求失败"

AGENTS_JSON="$AGENTS_JSON" node - "$BINDINGS_FILE" "$TDAI_USER_ID" "$PRUNE" <<'EOF'
const fs = require("fs");
const [file, userId, prune] = process.argv.slice(2);

{
  const resp = JSON.parse(process.env.AGENTS_JSON);
  if (resp.code !== 0) {
    console.error(`agent/list error: ${resp.message}`);
    process.exit(1);
  }
  const agents = (resp.data.items || []).filter((a) => a.status === "active");
  const byId = new Map(agents.map((a) => [a.agent_id, a]));

  const bindings = JSON.parse(fs.readFileSync(file, "utf8"));
  const token = Object.keys(bindings).find((k) => !k.startsWith("_"));
  if (!token) {
    console.error("no device token in bindings file");
    process.exit(1);
  }
  const binding = bindings[token];
  if (!Array.isArray(binding.identities)) {
    console.error(`token binding has no identities[] (legacy shape?) — fix ${file} first`);
    process.exit(1);
  }

  const have = new Set(binding.identities.map((i) => i.agentId));
  const names = new Set(binding.identities.map((i) => i.name));
  let added = 0;

  const slug = (s) =>
    s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";

  for (const a of agents) {
    if (have.has(a.agent_id)) continue;
    let name = slug(a.name);
    while (names.has(name)) name = `${name}-2`;
    names.add(name);
    binding.identities.push({
      name,
      description: a.description || a.name,
      teamId: a.team_id,
      agentId: a.agent_id,
      userId,
    });
    console.log(`+ added identity "${name}" (${a.agent_id})`);
    added++;
  }

  const stale = binding.identities.filter((i) => !byId.has(i.agentId));
  if (prune === "1" && stale.length) {
    binding.identities = binding.identities.filter((i) => byId.has(i.agentId));
    for (const s of stale) console.log(`- pruned identity "${s.name}" (${s.agentId} gone/inactive)`);
    if (binding.default && !binding.identities.some((i) => i.name === binding.default)) {
      delete binding.default;
      console.log(`- cleared default (identity removed)`);
    }
  } else {
    for (const s of stale) console.log(`! stale identity "${s.name}" (${s.agentId} not active in Core) — rerun with --prune to remove`);
  }

  fs.writeFileSync(file, JSON.stringify(bindings, null, 2) + "\n");
  console.log(`synced: ${binding.identities.length} identities on token ${token.slice(0, 12)}… (${added} added${prune === "1" ? `, ${stale.length} pruned` : ""})`);
}
EOF

if [[ "$RESTART" == "1" ]]; then
  "$SCRIPT_DIR/start-memory-mcp.sh" >/dev/null 2>&1 && ok "memory-mcp 已重启，picker 立即生效" || die "memory-mcp 重启失败（手动跑 start-memory-mcp.sh）"
else
  info "跳过重启：改动将在下次 start-memory-mcp.sh 后生效"
fi
