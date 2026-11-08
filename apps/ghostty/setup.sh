#!/bin/bash

# make a link from ~/.config/ghostty/config -> ./config
#
# 用脚本自身所在目录，而不是 $(pwd)：之前必须 cd 到 apps/ghostty 里才能跑对，
# 从别处执行会建出一条指向错误路径的软链（比如 ~/.shell/config）。
#
# 幂等靠 `ln -sfn`（第二次不会再报 "File exists"），但**不覆盖真实文件**：
# ~/.config/ghostty/config 如果是一份手写的真文件（不是软链），直接顶掉就是丢数据。
# 这点与 apps/pi、apps/opencode 的 setup.sh 保持一致（它们也是只替换软链）。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/config"
TARGET="$HOME/.config/ghostty/config"

if [ ! -f "$SOURCE" ]; then
    echo "✗ 找不到 $SOURCE" >&2
    exit 1
fi
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    echo "✗ $TARGET 已存在且不是软链，拒绝覆盖（确认不需要请先自行移走）" >&2
    exit 1
fi

mkdir -p "$(dirname "$TARGET")"
ln -sfn "$SOURCE" "$TARGET"
echo "✓ Linked ghostty config -> $TARGET"
