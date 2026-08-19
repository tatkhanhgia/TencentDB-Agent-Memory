# OpenCode — tdai-memory

Merge this directory's `opencode.json` `mcp` block into the project **`opencode.json`** (or `~/.config/opencode/opencode.json`).

**HTTP / remote (preferred).** The JSON file is the remote variant: `type` `remote`, `url` `http://127.0.0.1:8425/mcp`, `Authorization: Bearer tok-local-dev`. Replace the placeholder with a real `TDAI_MCP_TOKEN`.

**Stdio / local fallback.** If remote MCP is unavailable, use `type` `local` with the wrapper as a one-element `command` array. The wrapper sources env internally — do not add an `environment` block:

```json
{
  "mcp": {
    "tdai-memory": {
      "type": "local",
      "command": [
        "/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh"
      ]
    }
  }
}
```
