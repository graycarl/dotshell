#!/usr/bin/env bash
#
# slim_dump.sh — 给 mysqldump 的 .sql.gz 瘦身：保留指定表的结构，仅剔除其 INSERT 数据。
#
# 用法:
#   ./slim_dump.sh tmp/db_backup.sql.gz tmp/db_backup.slim.sql.gz
#
# 默认剔除下列表的数据（保留 CREATE TABLE）。其余表原样保留。
# 流式处理，不会在磁盘上落地完整解压文件。

set -euo pipefail

IN="${1:-tmp/db_backup.sql.gz}"
OUT="${2:-tmp/db_backup.slim.sql.gz}"

# 要清空数据（仅删 INSERT 行）的表，空格分隔（单行，兼容 BSD awk）。
STRIP_TABLES="silk_sqlquery silk_response network_subscription_details jobs data_event data_event_old axes_accesslog django_session operation_audit_trails admin_audit_trails publicapi_audit_trails record_tags"

if [[ ! -f "$IN" ]]; then
  echo "输入文件不存在: $IN" >&2
  exit 1
fi

# 把表名列表传给 awk，构建集合；
# 对目标表：丢弃其 INSERT INTO 行，并在结构块后插入一行注释标记数据已被剥离。
gzcat "$IN" \
| awk -v tables="$STRIP_TABLES" '
  BEGIN {
    n = split(tables, a, /[ \t\n]+/)
    for (i = 1; i <= n; i++) if (a[i] != "") strip[a[i]] = 1
  }
  # 匹配 INSERT INTO `name` ，精确取反引号内的表名
  /^INSERT INTO `/ {
    name = $0
    sub(/^INSERT INTO `/, "", name)
    sub(/`.*/, "", name)
    if (name in strip) {
      stripped[name] += 1
      next            # 丢弃这一行数据
    }
  }
  { print }
  END {
    for (t in strip)
      printf("-- [slim_dump] stripped data rows from table `%s` (INSERT lines removed: %d)\n", t, stripped[t]) > "/dev/stderr"
  }
' \
| gzip -c > "$OUT"

echo "完成: $OUT" >&2
ls -la "$IN" "$OUT" >&2
