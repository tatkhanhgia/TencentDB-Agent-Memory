# Claude Code — tdai-memory

Drop this directory's `mcp.json` at the **project root as `.mcp.json`**.

**HTTP (preferred).** The JSON file is the HTTP variant: Streamable HTTP at `http://127.0.0.1:8425/mcp` with `Authorization: Bearer tok-local-dev`. Replace the placeholder with a real `TDAI_MCP_TOKEN`.

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
