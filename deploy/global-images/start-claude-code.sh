#!/usr/bin/env bash
# Launch Claude Code against local MemoryProxy (full stack must be running).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/.claude-code.env"

MODEL="${1:-google/gemma-4-e4b}"

echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
echo "model=$MODEL"
echo "team=$TDAI_TEAM_ID agent=$TDAI_AGENT_ID task=$TDAI_TASK_ID"
echo ""
echo "Tip: first message may still ask to bind team assets if headers are not forwarded by CC."
echo "If asked: choose Local Coding Team → coder → default-task"
echo ""

# Claude Code does not always pass custom x-team-id headers; interactive form is OK.
# Prefer real claude binary on PATH.
if command -v claude >/dev/null 2>&1; then
  exec claude --model "$MODEL"
fi
# login shell fallback
if zsh -lic 'command -v claude' >/dev/null 2>&1; then
  exec zsh -lic "claude --model $(printf %q "$MODEL")"
fi
echo "ERROR: claude CLI not found on PATH. Install Claude Code CLI first." >&2
exit 1
