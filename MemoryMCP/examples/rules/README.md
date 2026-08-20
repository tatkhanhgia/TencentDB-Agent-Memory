Paste `CLAUDE.md.snippet` into the project `CLAUDE.md` (Claude Code), `cursor.mdc` into `.cursor/rules/` (Cursor, `alwaysApply: true`), `windsurfrules.snippet` into `.windsurfrules` (Windsurf), and `AGENTS.md.snippet` into `AGENTS.md` (Codex and OpenCode). These snippets teach the agent to read memory; they do not grant a write path.

Each snippet ends with a Skills paragraph. It is harmless when `TDAI_ENABLE_SKILLS=false` — the tools simply are not listed and the agent skips that paragraph — so paste it either way rather than maintaining two variants.

Claude Code has a second, richer option: `deploy/global-images/install-claude-skill.sh` installs `MemoryMCP/skills/tdai-memory/SKILL.md` into `~/.claude/skills/`, which carries the full Skill workflow and loads on demand instead of sitting in every prompt. Other harnesses do not read that format — for them the snippet above is the only guidance, which is why it repeats the essentials.
