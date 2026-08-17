---
name: tdai-memory
description: Use TDAI team memory tools for recall and (when enabled) explicit capture.
---

# TDAI Team Memory

You have MCP tools from the `tdai-memory` server. Use them. Do not invent memories.

## When to recall

Before answering questions about identity, preferences, past decisions, conventions, or prior work:

1. Call `tdai_memory_context` with the user query.
2. If you need more L1 hits, call `tdai_memory_search`.
3. If you need an older chat snippet, call `tdai_conversation_search`.
4. To read a scene path from the context index, call `tdai_scene_read`.

Answer from tool results. If tools fail, say so.

## When to capture

Only if `tdai_memory_capture` is listed (host set `TDAI_ENABLE_CAPTURE=true`):

- After a meaningful turn that produced a decision, preference, or reusable conclusion.
- Send **one incremental turn**: `user` + `assistant`. Never dump the full transcript.
- Always pass a stable `capture_id` for that turn and a `conversation_ref` for this chat.
- Retry the same `capture_id` + same texts if the call may have timed out.

Do not claim you auto-remember every message. Capture is explicit.

## What not to do

- Do not pass team/agent/user/task/API keys as tool arguments.
- Do not write recalled wrapper blocks back into capture.
- Do not say you lack memory tools when these tools are available.
