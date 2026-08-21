# Cursor — tdai-memory

Copy `mcp.json` to **`~/.cursor/mcp.json`** (global) or **`.cursor/mcp.json`** (project).

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

**HTTP (legacy, opt-in).** Only if you deliberately run the `:8425` daemon (`./start-memory-mcp.sh`; not started by default): `url` `http://127.0.0.1:8425/mcp` + `Authorization: Bearer <device token from .mcp.bindings.json>`.
