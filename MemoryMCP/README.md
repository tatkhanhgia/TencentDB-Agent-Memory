# tdai-memory-mcp (P0)

Read-only stdio MCP server for TencentDB Agent Memory. Any MCP-capable coding harness can list and call four tools against a running MemoryCore Gateway (`/v3`).

This is a **capability** surface (explicit tools). It does **not** auto-inject or auto-capture conversations. That remains MemoryProxy / native hooks.

## Tools

| Name | Purpose |
| --- | --- |
| `tdai_memory_context` | One-shot recall: L3 persona + L2 scene index + top L1. Always `scope: "self"`. Partial bundle if one source fails. |
| `tdai_memory_search` | L1 atomic search |
| `tdai_conversation_search` | L0 search; canonical Core field is `data.messages` |
| `tdai_scene_read` | Read one relative L2 scene path |

Identity is frozen from the environment at process start. Tool arguments cannot override tenant, task, endpoint, or API key.

Optional write (P1): set `TDAI_ENABLE_CAPTURE=true` to advertise `tdai_memory_capture`. Default is read-only. Capture is one incremental turn + `capture_id` (idempotent on Core) + `conversation_ref`.

Optional Skills (P2): set `TDAI_ENABLE_SKILLS=true` for `tdai_skill_search` / `tdai_skill_get`. Policy text: `skills/tdai-memory/SKILL.md`.

`tdai_memory_context` calls Core `POST /v3/memory/recall` when available so imported/fixed chat_memory (same team, Core ACL) is included with source attribution (`scope: "bound"`).

### Streamable HTTP (P3)

Set `TDAI_MCP_HTTP_PORT` (and `TDAI_MCP_BINDINGS`) instead of stdio:

```bash
TDAI_MCP_HTTP_PORT=8097
TDAI_MCP_HTTP_HOST=127.0.0.1
TDAI_MCP_BINDINGS='{"mcp-alice":{"teamId":"team-a","agentId":"agt-a","userId":"usr-a"}}'
```

Clients send `Authorization: Bearer mcp-alice`. That token is **not** the Core API key; Core credentials stay on the server. Unknown Origin is rejected unless listed in `TDAI_MCP_HTTP_ORIGINS`.

## Required environment

```text
TDAI_ENDPOINT      # e.g. http://127.0.0.1:8420
TDAI_API_KEY
TDAI_SERVICE_ID    # local instance is usually default
TDAI_TEAM_ID
TDAI_AGENT_ID
TDAI_USER_ID
```

Optional: `TDAI_TASK_ID`, `TDAI_TIMEOUT_MS`, `TDAI_MAX_CHARS`, `TDAI_LOG_LEVEL`.

Missing required values fail closed (no `default/default/default` fallback).

## Run

```bash
cd MemoryMCP
npm install
# build the local TypeScript SDK once
(cd ../sdk/memory-core/typescript && npm install && npm run build)
npm run build
npm test
tdai-memory-mcp   # or: node bin/tdai-memory-mcp.mjs
```

Logs go to **stderr**. stdout is MCP JSON-RPC only.

Harness snippets (no secrets) live under `examples/`.
