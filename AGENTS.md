# TDAI memory (read-only)

At session start, call `tdai_memory_context` once to load team memory before non-trivial work.

When a task references past decisions or conventions, use `tdai_memory_search` (and `tdai_scene_read` for detail) before re-deriving from scratch.

Do not write memory. Capture is automatic at session end (session-end hook, not the model).

Do not dump memory contents verbatim into files or commits.
