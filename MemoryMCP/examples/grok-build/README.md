# Grok / Grok Build — tdai-memory

Launch the stdio wrapper at `/Users/mac/Documents/Projects/MyProjects/TencentDB-Agent-Memory/deploy/global-images/tdai-memory-mcp.sh` — it sources env internally (no env block needed) and resolves the per-project identity itself (`.tdai-project.env` → folder-name ↔ Panel agent → machine default). Tool surface: `tdai_memory_context`, `tdai_memory_search`, `tdai_conversation_search`, `tdai_scene_read`, plus the Skill tools when `TDAI_ENABLE_SKILLS=true`.

HTTP at `http://127.0.0.1:8425/mcp` (Bearer device token) is legacy and opt-in — only if you deliberately run `./start-memory-mcp.sh`.
