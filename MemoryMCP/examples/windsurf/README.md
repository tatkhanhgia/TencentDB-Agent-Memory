# Windsurf — tdai-memory

Copy `mcp_config.json` to **`~/.codeium/windsurf/mcp_config.json`**.

**HTTP (preferred).** The JSON file uses Windsurf's `serverUrl` field pointing at `http://127.0.0.1:8425/mcp`. Auth header support is not confirmed for every Windsurf version; if your build accepts `headers`, add `"Authorization": "Bearer tok-local-dev"` (replace with a real `TDAI_MCP_TOKEN`). Do not invent other fields.

**Stdio fallback.** If HTTP is unavailable, use the wrapper as `command`. The wrapper sources env internally — do not add an `env` block:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh"
    }
  }
}
```
