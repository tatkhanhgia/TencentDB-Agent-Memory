# MemoryMCP harness examples

Two transports, same four tools (`tdai_memory_context`, `tdai_memory_search`, `tdai_conversation_search`, `tdai_scene_read`):

- **HTTP (preferred)** — `http://127.0.0.1:8425/mcp` with `Authorization: Bearer tok-local-dev` (replace with the real `TDAI_MCP_TOKEN` from `deploy/global-images/.mcp.env`, also printed by `start-memory-mcp.sh`).
- **Stdio fallback** — `command` is the wrapper `/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh`. The wrapper sources env internally; do **not** add an env block.

JSON files in each harness directory are the HTTP variant (valid JSON, no comments). Stdio is documented in that directory's `README.md`. Codex is stdio-only (`config.toml`).

Agent-facing “read memory, do not write” snippets: [`rules/`](rules/).

| Harness | HTTP | Stdio | Config on disk |
| --- | --- | --- | --- |
| Claude Code | preferred (`type: http`) | wrapper `command` | project `.mcp.json` — see [`claude-code/`](claude-code/) |
| Cursor | preferred (`url` + headers) | wrapper `command` | `~/.cursor/mcp.json` (or project `.cursor/mcp.json`) — see [`cursor/`](cursor/) |
| Windsurf | preferred (`serverUrl`) | wrapper `command` | `~/.codeium/windsurf/mcp_config.json` — see [`windsurf/`](windsurf/) |
| OpenCode | preferred (`type: remote`) | `type: local` + wrapper | project `opencode.json` — see [`opencode/`](opencode/) |
| Codex | — | preferred (reliable path) | `~/.codex/config.toml` — see [`codex/`](codex/) |
| Grok / Grok Build | if remote MCP is supported | wrapper | see [`grok-build/`](grok-build/) |
