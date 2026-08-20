---
name: tdai-memory
description: Use TDAI team memory tools for recall, Skill lookup, and (when enabled) explicit capture.
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

## When to use a Skill

Only if `tdai_skill_search` is listed (host set `TDAI_ENABLE_SKILLS=true`).

A Skill is a reusable SOP the team already proved out — a release checklist, a
debugging routine, a setup procedure. Prefer an existing Skill over re-deriving
the procedure yourself.

Look for one **before starting** any task that sounds routine or repeatable:
deploys, releases, migrations, incident triage, environment setup, review passes.

1. `tdai_skill_search` with 2–5 keywords from the task. Default scope is this
   agent's own Skills.
2. Nothing useful? Retry with `scope: "team"` — that searches every Skill the
   team shares, across agents. Do this before concluding no Skill exists.
3. `tdai_skill_get` on the best hit. You get the whole SKILL.md: trigger
   boundaries, steps, validation rules — plus a manifest of attached files.
4. For each manifest entry you actually need, `tdai_skill_file_read` with its
   `path`. Scripts arrive as text; `chmod +x` after you write one to disk.

Then follow the steps. Nothing executes a Skill for you — it is a procedure to
carry out with your own tools, not a program that runs itself.

Honour the Skill's own boundaries: if its "does not apply" section covers the
current situation, say so and stop rather than forcing a bad fit. If a Skill
looks stale or wrong, report that to the user — these tools are read-only, so
you cannot fix it here; edits happen in the web Panel.

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
