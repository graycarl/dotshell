#!/bin/bash
# 用 Marked 打开 plan 文档。
# Marked 不可用时静默失败（退出码 1）：不报错、不换别的 App 打开。
set -u

f="${1:-}"
[ -n "$f" ] && [ -f "$f" ] || exit 1
[ "$(uname -s)" = Darwin ] || exit 1
[ -d "/Applications/Marked 2.app" ] || [ -d "$HOME/Applications/Marked 2.app" ] || exit 1

/usr/bin/open -a "Marked 2" "$f" 2>/dev/null && exit 0
# Marked 装在非标准位置时（LaunchServices 仍能查到）
/usr/bin/open -b com.brettterpstra.marked2 "$f" 2>/dev/null && exit 0
exit 1
