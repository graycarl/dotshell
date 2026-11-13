#!/bin/sh
# acme.sh 续期任务（运行在 Asuswrt 路由器上）
#
# 由 cru 每天调用一次（也可靠 SSH 手动执行）：
#   - 证书：home.graycarl.me，DNS-01 校验（走 DNSPod API，不需要 80/443 入站）
#   - 续期成功后 acme.sh 会自动执行 --install-cert 登记的 reloadcmd（cert-deploy.sh）
#
# ⚠️ 该固件（TUF-BE6500 3.0.0.6）在 crond 会话里禁用了 curl/wget：
#    进程照常退出码 0，但没有任何输出/副作用。acme.sh 完全依赖 curl，
#    因此检测到 curl 不可用时，本脚本会「双重后台脱离会话」（祖先进程变 init）
#    后重新执行自己，脱离后的上下文里 curl 正常工作。

LOG=/jffs/.acme-home.log
ACME_HOME=/jffs/acme
TOKEN_FILE=/jffs/.dnspod
SELF=/jffs/scripts/acme-renew.sh
LOCK_DIR=/var/lock/acme-renew.lock

log() { echo "$(date '+%F %T') [acme-renew] $*" >> "$LOG"; }

# crond 会话里 curl 静默失效 → 脱离会话重跑
if [ "${FGW_DETACHED:-0}" != "1" ] && [ -z "$(/usr/sbin/curl --version 2>/dev/null)" ]; then
    log "当前会话 curl 不可用（crond 限制），脱离会话后重跑"
    ( ( export FGW_DETACHED=1; "$SELF" ) >/dev/null 2>&1 & )
    exit 0
fi

# 并发锁
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [ -n "$(find "$LOCK_DIR" -mmin +60 2>/dev/null)" ]; then
        rm -rf "$LOCK_DIR"
        mkdir "$LOCK_DIR" 2>/dev/null || { log "skip: 已有续期任务在跑"; exit 0; }
    else
        log "skip: 已有续期任务在跑"
        exit 0
    fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
echo $$ > "$LOCK_DIR/pid"

[ -f "$TOKEN_FILE" ] || { log "ERROR: $TOKEN_FILE missing"; exit 1; }

DP_Id=$(cut -d, -f1 "$TOKEN_FILE" | tr -d ' \r\n')
DP_Key=$(cut -d, -f2 "$TOKEN_FILE" | tr -d ' \r\n')
export DP_Id DP_Key

log "cron start"
sh /usr/sbin/acme.sh --home "$ACME_HOME" --cron --server letsencrypt >> "$LOG" 2>&1
_rc=$?
log "cron done rc=$_rc"
exit "$_rc"
