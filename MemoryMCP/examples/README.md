# MemoryMCP harness examples

**New here? Start with [ONBOARDING.html](ONBOARDING.html)** — the full 3-step guide (transport config per harness, identity model, write-path hook, troubleshooting), readable in a browser and by agents.

One transport for every harness, same four read tools (`tdai_memory_context`, `tdai_memory_search`, `tdai_conversation_search`, `tdai_scene_read`), plus four optional Skill tools — see [Skills](#skills-optional) below:

- **Stdio (standard)** — `command` is the wrapper `/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh`. The wrapper sources env internally (do **not** add an env block) and resolves the per-project identity itself — see [Identity](#identity-automatic-per-project) below. No token, no port, no daemon.
- **HTTP (legacy, opt-in)** — a Streamable HTTP daemon on `:8425` with device-token auth still exists for remote access or the interactive identity picker, but it no longer starts by default (`MCP_HTTP=1 ./start-all.sh` or `./start-memory-mcp.sh` to run it). Only use it when stdio genuinely cannot work.

JSON files in each harness directory are the stdio variant (valid JSON, no comments).

Agent-facing “read memory, do not write” snippets: [`rules/`](rules/).

## Skills (optional)

Skills are reusable SOPs distilled from past work — a different asset from memory, gated behind `TDAI_ENABLE_SKILLS=true` in `.mcp.env` (stdio wrappers read it at launch, so just open a new session). Four read-only tools appear once enabled:

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

## Identity (automatic, per project)

One project = one agent. The stdio wrapper resolves the identity for the project it is launched in (harnesses start stdio MCP servers with cwd = project dir), using the **same resolution the write hook uses** (`deploy/global-images/_identity.sh`), so a session always recalls the store its lessons are written to:

1. **`.tdai-project.env` at the project root** — explicit override (`TDAI_AGENT_ID=agt-…`; write it by hand with the agent id from the Panel, or run `sync-memory-identities.sh --link <project-dir> <agent-name>`).
2. **Folder-name convention (zero setup)** — an active Panel registry agent whose slugged name matches the project folder name. Name the agent after the folder and both reads and writes route themselves.
3. **Machine default** from `.mcp.env`.

The chosen route is logged to stderr at startup (`identity route=… agent=…`), and the final agent id is validated against the registry — a stale `.tdai-project.env` pointing at a deleted/archived agent warns instead of silently binding. Identity is fixed for the lifetime of the server process; after changing `.tdai-project.env` or renaming agents, reconnect the MCP server (new session).

`tdai_identity_list` / `tdai_identity_use` (the in-session picker) exist only in the legacy HTTP mode — on stdio there is nothing to pick.

| Harness | Transport | Config on disk |
| --- | --- | --- |
| Claude Code | stdio wrapper `command` | project `.mcp.json` or `~/.claude.json` user scope — see [`claude-code/`](claude-code/) |
| Cursor | stdio wrapper `command` | `~/.cursor/mcp.json` (or project `.cursor/mcp.json`) — see [`cursor/`](cursor/) |
| Windsurf | stdio wrapper `command` | `~/.codeium/windsurf/mcp_config.json` — see [`windsurf/`](windsurf/) |
| OpenCode | `type: local` + wrapper | project `opencode.json` — see [`opencode/`](opencode/) |
| Codex | stdio wrapper `command` | `~/.codex/config.toml` — see [`codex/`](codex/) |
| Grok / Grok Build | stdio wrapper `command` | see [`grok-build/`](grok-build/) |
