# TDAI memory (read-only)

At session start, call `tdai_memory_context` once to load team memory before non-trivial work.

When a task references past decisions or conventions, use `tdai_memory_search` (and `tdai_scene_read` for detail) before re-deriving from scratch.

Do not write memory. Capture is automatic at session end (session-end hook, not the model).

Do not dump memory contents verbatim into files or commits.

Skills are separate from memory: reusable SOPs the team already proved out. If `tdai_skill_list` is listed, check for one before starting anything routine or repeatable. Nothing is injected automatically, so call `tdai_skill_list` to see the catalogue — default scope is this agent's own Skills, `scope: "team"` covers the whole team. Use `tdai_skill_search` for keywords once the library is large, but an empty search means those words missed, not that no Skill applies. Then `tdai_skill_get` for the full procedure and `tdai_skill_file_read` for any file in its manifest. Nothing executes a Skill for you — follow its steps with your own tools.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **TencentDB-Agent-Memory** (13387 symbols, 37733 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "feat/server_team"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/TencentDB-Agent-Memory/context` | Codebase overview, check index freshness |
| `gitnexus://repo/TencentDB-Agent-Memory/clusters` | All functional areas |
| `gitnexus://repo/TencentDB-Agent-Memory/processes` | All execution flows |
| `gitnexus://repo/TencentDB-Agent-Memory/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
