# Claude Code — tdai-memory

Drop this directory's `mcp.json` at the **project root as `.mcp.json`**, or add the same block to `~/.claude.json` (`mcpServers`) for user scope — one config for every project on this machine (the wrapper resolves each project's identity itself).

**Stdio (standard).** The JSON file points `command` at the wrapper. The wrapper sources env internally and resolves the per-project identity (`.tdai-project.env` → folder-name ↔ Panel agent → machine default) — do **not** add an `env` block:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh"
    }
  }
}
```

**HTTP (legacy, opt-in).** Only if you deliberately run the `:8425` daemon (`./start-memory-mcp.sh`; not started by default): `type: "http"`, `url: "http://127.0.0.1:8425/mcp"`, `Authorization: Bearer <device token from .mcp.bindings.json>`.
