# TDAI memory (read-only)

At session start, call `tdai_memory_context` once to load team memory before non-trivial work.

When a task references past decisions or conventions, use `tdai_memory_search` (and `tdai_scene_read` for detail) before re-deriving from scratch.

Do not write memory. Capture is automatic at session end (session-end hook, not the model).

Do not dump memory contents verbatim into files or commits.

Skills are separate from memory: reusable SOPs the team already proved out. If `tdai_skill_list` is listed, check for one before starting anything routine or repeatable. Nothing is injected automatically, so call `tdai_skill_list` to see the catalogue — default scope is this agent's own Skills, `scope: "team"` covers the whole team. Use `tdai_skill_search` for keywords once the library is large, but an empty search means those words missed, not that no Skill applies. Then `tdai_skill_get` for the full procedure and `tdai_skill_file_read` for any file in its manifest. Nothing executes a Skill for you — follow its steps with your own tools.
