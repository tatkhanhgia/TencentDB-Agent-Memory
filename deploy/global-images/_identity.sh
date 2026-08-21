#!/usr/bin/env bash
# Shared per-project TDAI identity resolution — sourced by BOTH the reflect
# hook (write path) and the stdio MCP wrapper (read path) so recall and
# capture can never disagree about which agent a project belongs to.
#
# Not executable on its own; `source` it, then call:
#   resolve_project_identity <start-dir>
#
# Requires in the environment: $NODE (node >= 20); for registry matching and
# validation also TDAI_ENDPOINT + TDAI_API_KEY + TDAI_TEAM_ID.
# May export TDAI_AGENT_ID / TDAI_TEAM_ID / TDAI_USER_ID (from
# .tdai-project.env or a registry match); always sets TDAI_IDENTITY_ROUTE to
# "file" | "folder-name:<name>" | "default".
#
# Best-effort by contract: never exits non-zero, never writes to stdout
# (MCP stdio owns stdout) — diagnostics go to stderr only.

# Fetch the Panel agent registry for the current team. Prints the raw JSON
# response, or nothing when config is incomplete or the request fails.
_tdai_registry_agents() {
  [[ -n "${TDAI_ENDPOINT:-}" && -n "${TDAI_API_KEY:-}" && -n "${TDAI_TEAM_ID:-}" ]] || return 0
  curl -sS --max-time 3 -X POST "${TDAI_ENDPOINT%/}/v3/meta/agent/list" \
    -H "Authorization: Bearer local" \
    -H "x-tdai-user-key: ${TDAI_API_KEY}" \
    -H "x-tdai-service-id: ${TDAI_SERVICE_ID:-default}" \
    -H "Content-Type: application/json" \
    -d "{\"team_id\":\"${TDAI_TEAM_ID}\",\"limit\":100}" 2>/dev/null || true
}

# Resolve the identity for the project containing <start-dir>, in priority order:
#   1. .tdai-project.env at the project root (explicit override;
#      TDAI_AGENT_ID=agt-…, TDAI_TEAM_ID/TDAI_USER_ID optional)
#   2. A registry agent whose slugged name matches the project folder name
#      (convention: name the Panel agent after the project folder — zero setup)
#   3. Whatever the environment already carries (the .mcp.env default)
resolve_project_identity() {
  local start="${1:-}"
  TDAI_IDENTITY_ROUTE="default"
  export TDAI_IDENTITY_ROUTE
  [[ -n "$start" && -d "$start" ]] || return 0

  local dir="$start" project_root="$start"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -f "$dir/.tdai-project.env" ]]; then
      set -a
      # shellcheck disable=SC1090,SC1091
      source "$dir/.tdai-project.env"
      set +a
      TDAI_IDENTITY_ROUTE="file"
      project_root="$dir"
      break
    fi
    if [[ -d "$dir/.git" ]]; then
      project_root="$dir"
      break
    fi
    dir="$(dirname "$dir")"
  done

  local registry=""
  registry="$(_tdai_registry_agents)"

  # Convention match: project folder name ↔ registry agent name (both slugged).
  if [[ "$TDAI_IDENTITY_ROUTE" == "default" && -n "$registry" ]]; then
    local match_id=""
    match_id="$(printf '%s' "$registry" | PROJECT_NAME="$(basename "$project_root")" "$NODE" -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try {
          const resp = JSON.parse(d);
          if (resp.code !== 0) return;
          const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          const want = slug(process.env.PROJECT_NAME || "");
          if (!want) return;
          const hit = (resp.data.items || []).find((a) => a.status === "active" && slug(a.name) === want);
          if (hit) process.stdout.write(hit.agent_id);
        } catch {}
      });' || true)"
    if [[ -n "$match_id" ]]; then
      export TDAI_AGENT_ID="$match_id"
      TDAI_IDENTITY_ROUTE="folder-name:$(basename "$project_root")"
    fi
  fi

  # Validate the final agent id against the registry: a stale
  # .tdai-project.env (agent deleted/archived on the Panel) should be loud,
  # not a silent write into the void.
  if [[ -n "$registry" && -n "${TDAI_AGENT_ID:-}" ]]; then
    local verdict=""
    verdict="$(printf '%s' "$registry" | WANT_ID="$TDAI_AGENT_ID" "$NODE" -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try {
          const resp = JSON.parse(d);
          if (resp.code !== 0) return;
          const hit = (resp.data.items || []).find((a) => a.agent_id === process.env.WANT_ID);
          process.stdout.write(!hit ? "missing" : hit.status === "active" ? "ok" : "inactive");
        } catch {}
      });' || true)"
    case "$verdict" in
      missing)
        echo "[tdai-identity] warning: TDAI_AGENT_ID=${TDAI_AGENT_ID} (route=${TDAI_IDENTITY_ROUTE}) not found in the Panel agent registry" >&2
        ;;
      inactive)
        echo "[tdai-identity] warning: TDAI_AGENT_ID=${TDAI_AGENT_ID} (route=${TDAI_IDENTITY_ROUTE}) exists but is not active in the Panel agent registry" >&2
        ;;
    esac
  fi
  return 0
}
