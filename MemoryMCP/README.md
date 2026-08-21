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

Optional Skills (P2): set `TDAI_ENABLE_SKILLS=true` for `tdai_skill_list` / `tdai_skill_search` / `tdai_skill_get` / `tdai_skill_file_read`. Policy text: `skills/tdai-memory/SKILL.md`.

| Name | Purpose |
| --- | --- |
| `tdai_skill_list` | The catalogue — no query needed. Same scope rule. Use it first, and whenever a search comes back empty. |
| `tdai_skill_search` | Keyword search (BM25 over name/description/body). Defaults to the active identity's own Skills; `scope: "team"` drops the owner filter and searches the whole team library. |
| `tdai_skill_get` | Full SKILL.md + resource manifest for one skill (optionally a historical `version`). |
| `tdai_skill_file_read` | One resource file from the manifest, e.g. `scripts/run.sh`. Content is truncated to `max_chars` (`size_bytes` still reports the real size). |

Skill tools are read-only — no create/update/delete here. Writes stay in the Panel and MemoryProxy.

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

## tdai-reflect

Session-end reflection CLI (`bin/tdai-reflect.mjs`, installed as `tdai-reflect`). Point it at a finished session transcript from a `SessionEnd` hook; it decides whether the session produced any **durable** lesson — an ADR with rationale, a system-impacting change, a project constraint, a lasting user preference — and writes at most a few of them to L0 via the SDK. **Writing nothing is the normal outcome.**

```bash
tdai-reflect --transcript ~/.claude/projects/<slug>/<session>.jsonl --format claude-code
```

| Option | Meaning |
| --- | --- |
| `--transcript <path>` | transcript file (required) |
| `--format <fmt>` | `claude-code` \| `generic-jsonl` (required) |
| `--session-id <id>` | host session id; default: from the transcript, else sha256 of the transcript path |
| `--max-lessons <n>` | default 3, hard cap 5 |
| `--min-turns <n>` | prefilter: skip shorter sessions, default 6 |
| `--dry-run` | extract only; print lessons instead of writing |
| `--quiet` | only errors on stderr |

Extra environment on top of the identity block above (all fail-closed):

```text
TDAI_REFLECT_LLM_BASE_URL   # OpenAI-compatible, e.g. http://127.0.0.1:4000/v1
TDAI_REFLECT_LLM_API_KEY
TDAI_REFLECT_LLM_MODEL
TDAI_REFLECT_TIMEOUT_MS     # optional, default 60000
```

`--dry-run` still requires the full environment (identity *and* LLM); it only suppresses the write.

The extraction call asks for `response_format: {type:"json_object"}` first. Providers that reject it with HTTP 400 (LM Studio: *`response_format.type` must be `json_schema` or `text`*) get one automatic retry without the field — the response parser already tolerates fenced or prose-wrapped JSON. A stderr warning records the fallback, and any HTTP error message carries the first ~200 chars of the provider's response body so 400s are debuggable.

Transcript parsing is tolerant — tool blocks, meta lines, and malformed lines are skipped, never fatal. Transcripts longer than ~60k chars keep the head and the tail, since decisions cluster at the end. Each lesson is deduped against L1 (`searchAtomic`, normalized-token Jaccard ≥ 0.6 against the title) before writing, and every write carries `capture_id = reflect-<sessionId>-<index>` so a retried hook is idempotent on Core.

Written content is a pure function of the transcript — the footer date is the transcript's last timestamp (omitted entirely if it has none), never the wall clock — so a replayed capture hashes identically on Core. If Core still reports a conflict (409, or a 409xx business code) for a capture id, that lesson is counted as already captured and the run continues; re-running the hook on the same session writes nothing and exits 0.

stdout is a single JSON summary (`{"status":"written|empty|skipped|dry-run","lessons":[...],"written":n}`); diagnostics go to stderr. Exit codes for the hook wrapper: `0` ok (including "nothing written"), `2` usage/config, `3` transcript unreadable/unparseable, `4` LLM call failed, `5` memory write failed. It never throws an unhandled exception.
