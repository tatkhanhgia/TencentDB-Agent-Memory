# Grok / Grok Build — tdai-memory

If the harness supports remote MCP, use Streamable HTTP at `http://127.0.0.1:8425/mcp` with `Authorization: Bearer tok-local-dev` (replace with a real `TDAI_MCP_TOKEN`). Otherwise launch the stdio wrapper at `/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh` — it sources env internally, so no env block is needed. The tool surface is identical either way: `tdai_memory_context`, `tdai_memory_search`, `tdai_conversation_search`, `tdai_scene_read`.
