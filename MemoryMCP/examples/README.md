# MemoryMCP harness examples

**New here? Start with [ONBOARDING.html](ONBOARDING.html)** — the full 3-step guide (transport config per harness, identity model, write-path hook, troubleshooting), readable in a browser and by agents.

Two transports, same four tools (`tdai_memory_context`, `tdai_memory_search`, `tdai_conversation_search`, `tdai_scene_read`):

- **HTTP (preferred)** — `http://127.0.0.1:8425/mcp` with `Authorization: Bearer tok-local-dev` (replace with the real `TDAI_MCP_TOKEN` from `deploy/global-images/.mcp.env`, also printed by `start-memory-mcp.sh`).
- **Stdio fallback** — `command` is the wrapper `/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh`. The wrapper sources env internally; do **not** add an env block.

JSON files in each harness directory are the HTTP variant (valid JSON, no comments). Stdio is documented in that directory's `README.md`. Codex is stdio-only (`config.toml`).

Agent-facing “read memory, do not write” snippets: [`rules/`](rules/).

## Multi-identity device token (optional)

Instead of one token per agent/project, a single **device token** can map to several memory identities (one per agent/project). Declare them in `deploy/global-images/.mcp.bindings.json` (see `.mcp.bindings.json.example`); `start-memory-mcp.sh` merges the file into the server bindings on start. Then every harness uses the same one-time config with that token, and adding a new agent never touches harness configs again.

Per session, the active identity is chosen once:

- **Single identity or `default` declared** — binds silently, nothing to do.
- **Multiple identities, no default** — the first memory tool call asks the user to pick via MCP **elicitation** (a native picker in harnesses that support it). Harnesses without elicitation get an `identity_not_selected` error listing the identities, plus two extra tools: `tdai_identity_list` and `tdai_identity_use {"name": "…"}` for the agent to bind (it should ask the user which one when unclear). Switching mid-session with `tdai_identity_use` is always allowed.

| Harness | HTTP | Stdio | Config on disk |
| --- | --- | --- | --- |
| Claude Code | preferred (`type: http`) | wrapper `command` | project `.mcp.json` — see [`claude-code/`](claude-code/) |
| Cursor | preferred (`url` + headers) | wrapper `command` | `~/.cursor/mcp.json` (or project `.cursor/mcp.json`) — see [`cursor/`](cursor/) |
| Windsurf | preferred (`serverUrl`) | wrapper `command` | `~/.codeium/windsurf/mcp_config.json` — see [`windsurf/`](windsurf/) |
| OpenCode | preferred (`type: remote`) | `type: local` + wrapper | project `opencode.json` — see [`opencode/`](opencode/) |
| Codex | — | preferred (reliable path) | `~/.codex/config.toml` — see [`codex/`](codex/) |
| Grok / Grok Build | if remote MCP is supported | wrapper | see [`grok-build/`](grok-build/) |
