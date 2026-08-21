# MemoryMCP harness examples

**New here? Start with [ONBOARDING.html](ONBOARDING.html)** — the full 3-step guide (transport config per harness, identity model, write-path hook, troubleshooting), readable in a browser and by agents.

Two transports, same four read tools (`tdai_memory_context`, `tdai_memory_search`, `tdai_conversation_search`, `tdai_scene_read`), plus four optional Skill tools — see [Skills](#skills-optional) below:

- **HTTP (preferred)** — `http://127.0.0.1:8425/mcp` with `Authorization: Bearer tok-local-dev` (replace with the real device token from `deploy/global-images/.mcp.bindings.json`, also printed by `start-memory-mcp.sh`).
- **Stdio fallback** — `command` is the wrapper `/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh`. The wrapper sources env internally; do **not** add an env block.

JSON files in each harness directory are the HTTP variant (valid JSON, no comments). Stdio is documented in that directory's `README.md`. Codex is stdio-only (`config.toml`).

Agent-facing “read memory, do not write” snippets: [`rules/`](rules/).

## Skills (optional)

Skills are reusable SOPs distilled from past work — a different asset from memory, gated behind `TDAI_ENABLE_SKILLS=true` in `.mcp.env` (restart the server after changing it). Three read-only tools appear once enabled:

| Tool | Purpose |
| --- | --- |
| `tdai_skill_list` | The catalogue — no query needed. Defaults to the active identity's own Skills; `scope: "team"` lists the whole team library. |
| `tdai_skill_search` | Keyword search. Defaults to the active identity's own Skills; `scope: "team"` searches the whole team library. |
| `tdai_skill_get` | Full SKILL.md + manifest of attached resource files. |
| `tdai_skill_file_read` | One file from that manifest, e.g. `scripts/run.sh`. |

Two things that surprise people:

- **Nothing enumerates Skills for the agent.** It must call `tdai_skill_list` to learn what exists — searching blind can miss a Skill whose wording differs from the task.
- **Nothing auto-injects Skills.** Unlike MemoryProxy — which pushes an `<available_skills>` catalogue into every system prompt — the MCP path is pull-only. The agent finds a Skill only if it decides to search, which is what the rules snippet and the Claude Code skill are for.
- **Nothing executes a Skill.** It is a procedure to carry out with the harness's own tools, not a program.

Enabling the flag is therefore step one of two. Step two is telling the agent to look:

- **Claude Code** — `deploy/global-images/install-claude-skill.sh` installs `MemoryMCP/skills/tdai-memory/SKILL.md` into `~/.claude/skills/`, loaded on demand.
- **Every other harness** — the Skills paragraph in [`rules/`](rules/), pasted into that harness's rules file.

Skip both and the agent still has the tools; it just has to infer from the tool descriptions when to reach for them.

## Device token & identities

Every token is a **device token** mapping to one or more memory identities (one per agent/project), declared in `deploy/global-images/.mcp.bindings.json` (bootstrapped on first `start-memory-mcp.sh` run; template: `.mcp.bindings.json.example`). Every harness uses the same one-time config with that token, and adding a new agent never touches harness configs again. Single-purpose tokens hard-bound to one identity in `.mcp.env` were removed.

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
