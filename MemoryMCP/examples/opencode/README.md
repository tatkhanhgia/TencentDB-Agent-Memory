# OpenCode — tdai-memory

Merge this directory's `opencode.json` `mcp` block into the project **`opencode.json`** (or `~/.config/opencode/opencode.json`).

**Stdio / local (standard).** The JSON file is the `type: local` variant with the wrapper as a one-element `command` array. The wrapper sources env internally and resolves the per-project identity (`.tdai-project.env` → folder-name ↔ Panel agent → machine default) — do **not** add an `environment` block:

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

**HTTP / remote (legacy, opt-in).** Only if you deliberately run the `:8425` daemon (`./start-memory-mcp.sh`; not started by default): `type` `remote`, `url` `http://127.0.0.1:8425/mcp`, `Authorization: Bearer <device token from .mcp.bindings.json>`.
