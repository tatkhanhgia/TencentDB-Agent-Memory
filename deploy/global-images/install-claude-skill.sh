#!/usr/bin/env bash
# 把 MemoryMCP/skills/tdai-memory 装进 Claude Code 的 skills 目录。
#
# 为什么需要这一步：MCP 只负责把工具送到 harness 手里（ListTools），
# 但"什么时候该去找 Skill、找到后怎么用"这段策略文本是 Claude Code 的
# SKILL.md 格式，MCP 协议不负责分发。不装这一步，模型只能靠 tool
# description 自己领悟；装了之后 Claude Code 会按 description 匹配、
# 需要时才载入，不占常驻上下文。
#
#   ./install-claude-skill.sh                 # → ~/.claude/skills/tdai-memory
#   ./install-claude-skill.sh --dest DIR      # 装到别的 skills 根目录
#   ./install-claude-skill.sh --force         # 目标已存在且不是我们的也照装
#
# 仅对 Claude Code 有效。Cursor / Windsurf / Codex 等不读这个格式，
# 它们靠 examples/rules/ 里的规则片段 —— 见 MemoryMCP/examples/README.md。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$REPO_ROOT/MemoryMCP/skills/tdai-memory"
SKILLS_ROOT="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
FORCE=0

while (( $# > 0 )); do
  case "$1" in
    --dest)  SKILLS_ROOT="${2:?--dest 需要一个目录}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

[[ -f "$SRC/SKILL.md" ]] || die "找不到源文件：$SRC/SKILL.md"

DEST="$SKILLS_ROOT/tdai-memory"

# 目标已存在时先确认那是我们的 skill，不是同名的别人东西。
if [[ -e "$DEST" ]]; then
  if [[ $FORCE -eq 0 ]] && ! grep -q '^name: tdai-memory$' "$DEST/SKILL.md" 2>/dev/null; then
    die "$DEST 已存在但不像本项目的 skill。确认后用 --force 覆盖。"
  fi
  if diff -rq "$SRC" "$DEST" >/dev/null 2>&1; then
    ok "已是最新：$DEST"
    exit 0
  fi
  info "覆盖已有版本：$DEST"
fi

mkdir -p "$SKILLS_ROOT"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
ok "已安装：$DEST"

echo ""
echo "  下一步 —— skill 里的 Skill 工具部分要真正可用，还需要："
echo "    1) .mcp.env 里设 TDAI_ENABLE_SKILLS=true"
echo "    2) ./start-memory-mcp.sh（幂等重启；stdio 接法则重启 harness 即可）"
echo ""
echo "  重启 Claude Code 后生效（skill 在会话启动时枚举）。"
