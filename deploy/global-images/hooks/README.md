# Session-end reflection hooks

Write path for team memory is **hook-based and selective** — the model never
writes memory itself. At session end, `tdai-reflect` (MemoryMCP) parses the
transcript, asks an LLM whether the session produced durable lessons
(ADRs, system-impacting decisions, durable preferences — empty result is the
normal case), dedupes against existing memory, and writes at most a few
items to MemoryCore L0 with idempotent capture ids.

## Claude Code (SessionEnd)

Add to `~/.claude/settings.json` (global) or `<project>/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/hooks/tdai-reflect-hook.sh"
          }
        ]
      }
    ]
  }
}
```

The hook is fire-and-forget: it detaches `tdai-reflect` and always exits 0,
so session shutdown is never blocked. Output lands in
`deploy/global-images/.reflect.log`.

## Unbound projects are refused

The hook resolves the project's identity with the same `_identity.sh` the MCP
wrapper uses. If the project binds to no agent of its own (no
`.tdai-project.env`, no Panel agent named after the folder), the hook writes a
`refused:` line to `.reflect.log` and exits without calling the LLM: the only
target available would be the machine default, which belongs to another
project. Bind the project first, or set `TDAI_ALLOW_DEFAULT_IDENTITY=1` in
`.mcp.env` to restore the old shared-default behaviour.

## Config sources (resolved by the hook, in order)

1. `deploy/global-images/.mcp.env` — TDAI identity + `TDAI_REFLECT_LLM_*`
2. `.admin-key` — API key fallback when `TDAI_API_KEY` is empty
3. `.env` — `MEMORY_LLM_*` fallback for the reflect LLM
   (`host.docker.internal` rewritten to `127.0.0.1`)

## Other harnesses

- **OpenCode**: plugin event on session completion → call
  `MemoryMCP/bin/tdai-reflect.mjs --format generic-jsonl` with an exported
  transcript.
- **Codex**: `notify` hook + rollout JSONL under `~/.codex/sessions/`.
- **Cursor / Windsurf / Grok Build**: no reliable session-end hook today —
  they stay read-only via MCP; lessons written from other harnesses are
  still visible to them.
