#!/usr/bin/env bash
# 兼容层：真正的实现已统一到 ~/.shell/tools/fgw/start.sh
# （旧版本在这里内联生成 /jffs/scripts/firewall-start，会覆盖掉 fgw-extra 钩子）
set -euo pipefail
exec "$HOME/.shell/tools/fgw/start.sh" "$@"
