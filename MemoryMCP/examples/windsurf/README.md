# Windsurf — tdai-memory

Copy `mcp_config.json` to **`~/.codeium/windsurf/mcp_config.json`**.

**Stdio (standard).** The JSON file points `command` at the wrapper. The wrapper sources env internally (it also finds `node` when GUI-launched Windsurf lacks a shell PATH) and resolves the per-project identity (`.tdai-project.env` → folder-name ↔ Panel agent → machine default) — do **not** add an `env` block:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh"
    }
  }
}
```

**HTTP (legacy, opt-in).** Only if you deliberately run the `:8425` daemon (`./start-memory-mcp.sh`; not started by default): `serverUrl` `http://127.0.0.1:8425/mcp`; add `headers` with `Authorization: Bearer <device token>` if your Windsurf build supports it. Do not invent other fields.
