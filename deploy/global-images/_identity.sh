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
# "file" | "folder-name:<name>" | "default", and TDAI_IDENTITY_BOUND to 1 when
# the project resolved to an agent of its own, 0 when it fell back to the
# machine default. Callers use BOUND to decide whether this project may touch
# memory at all — the default agent belongs to whoever set up the machine, not
# to every project that happens to run here.
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
  TDAI_IDENTITY_BOUND="0"
  export TDAI_IDENTITY_ROUTE TDAI_IDENTITY_BOUND
  [[ -n "$start" && -d "$start" ]] || return 0

  local dir="$start" project_root="$start"
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    if [[ -f "$dir/.tdai-project.env" ]]; then
      set -a
      # shellcheck disable=SC1090,SC1091
      source "$dir/.tdai-project.env"
      set +a
      TDAI_IDENTITY_ROUTE="file"
      TDAI_IDENTITY_BOUND="1"
      project_root="$dir"
      break
    fi
    if [[ -d "$dir/.git" ]]; then
      project_root="$dir"
      break
    fi
    dir="$(dirname "$dir")"
  done

  # Publish the resolved root. Callers that print "create a Panel agent named X"
  # must use this, not basename "$PWD": identity is matched against the project
  # root found by walking up to .tdai-project.env or .git, so a session started
  # in a subdirectory would otherwise be told to create an agent named after the
  # subdirectory — a name nothing matches, and one that may already belong to a
  # different agent.
  export TDAI_PROJECT_ROOT="$project_root"

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
      TDAI_IDENTITY_BOUND="1"
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
    # A binding that points at an agent the Panel does not have is worse than
    # no binding: Core accepts writes for an unknown agent_id and reports
    # success, so the lessons land somewhere nothing can ever read them. Treat
    # it as unbound — memory off, writes refused — instead of warning into a
    # stderr stream no harness shows.
    case "$verdict" in
      missing)
        echo "[tdai-identity] warning: TDAI_AGENT_ID=${TDAI_AGENT_ID} (route=${TDAI_IDENTITY_ROUTE}) not found in the Panel agent registry — treating this project as unbound" >&2
        TDAI_IDENTITY_BOUND="0"
        TDAI_IDENTITY_INVALID="missing"
        export TDAI_IDENTITY_BOUND TDAI_IDENTITY_INVALID
        ;;
      inactive)
        echo "[tdai-identity] warning: TDAI_AGENT_ID=${TDAI_AGENT_ID} (route=${TDAI_IDENTITY_ROUTE}) exists but is not active in the Panel agent registry — treating this project as unbound" >&2
        TDAI_IDENTITY_BOUND="0"
        TDAI_IDENTITY_INVALID="inactive"
        export TDAI_IDENTITY_BOUND TDAI_IDENTITY_INVALID
        ;;
    esac
  fi
  return 0
}
