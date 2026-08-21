# TDAI memory (read-only)

At session start, call `tdai_memory_context` once to load team memory before non-trivial work.

When a task references past decisions or conventions, use `tdai_memory_search` (and `tdai_scene_read` for the full scene) before re-deriving from scratch.

Do not write memory yourself. Capture runs automatically at session end via a hook, not the model.

If recall comes back with `unbound: true`, this project is not bound to a memory agent: it genuinely has no memory, and lessons from this session will not be captured. Do not fall back to another project's memory, and say so plainly rather than treating it as a tool failure. Binding it takes one of: a Panel agent named after the project folder, or `TDAI_AGENT_ID=agt-…` in `.tdai-project.env` at the project root (new session required). Skills stay available either way — they are team assets.

Do not dump memory contents verbatim into files or commits.

Skills are separate from memory: reusable SOPs the team already proved out. If `tdai_skill_list` is listed, check for one before starting anything routine or repeatable. Nothing is injected automatically, so call `tdai_skill_list` to see the catalogue — default scope is this agent's own Skills, `scope: "team"` covers the whole team. Use `tdai_skill_search` for keywords once the library is large, but an empty search means those words missed, not that no Skill applies. Then `tdai_skill_get` for the full procedure and `tdai_skill_file_read` for any file in its manifest. Nothing executes a Skill for you — follow its steps with your own tools.
