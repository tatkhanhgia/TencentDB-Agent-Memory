# TDAI memory (read-only)

At session start, call `tdai_memory_context` once to load team memory before non-trivial work.

When a task references past decisions or conventions, use `tdai_memory_search` (and `tdai_scene_read` for the full scene) before re-deriving from scratch.

Do not write memory yourself. Capture runs automatically at session end via a hook, not the model.

Do not dump memory contents verbatim into files or commits.

Skills are separate from memory: reusable SOPs the team already proved out. If `tdai_skill_search` is listed, check for one before starting anything routine or repeatable. Search agent scope first, then retry with `scope: "team"` before concluding none exists; `tdai_skill_get` for the full procedure, `tdai_skill_file_read` for any file in its manifest. Nothing executes a Skill for you — follow its steps with your own tools.
