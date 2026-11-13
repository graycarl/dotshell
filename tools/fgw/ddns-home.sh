#!/bin/sh
# home.graycarl.me 的 DNSPod DDNS 更新（运行在 Asuswrt 路由器上）
#
# 设计要点：
#   1. 快路径：先比 nvram wan0_ipaddr 与缓存 IP，未变化直接退出（零网络请求）
#   2. 变化时才实测真实出口 IPv4
#      —— 路由器默认优先走 IPv6，取"我的 IP"这类服务必须强制 IPv4
#   3. 只在 IP 变化时调一次 Record.Ddns；每 24h 做一次 Record.Info 对账，防 DNS 漂移
#   4. record_id 缓存失效时（例如记录被删后重建）自动用 Record.List 重新发现
#   5. HTTP 全部走 `openssl s_client`，不用 curl/wget
#      —— 实测该固件（TUF-BE6500 3.0.0.6）在 crond 会话里 curl/wget 会静默空跑
#         （返回 0、无输出、不建文件），而 openssl 正常，所以 cron 里只能用 openssl
#
# 依赖：
#   /jffs/.dnspod           内容 "<DNSPod ID>,<Token>"，权限 600
#   /jffs/.ddns-home.state  内容 "<ip> <record_id> <last_reconcile_epoch>"（脚本自维护）
#   nvram / openssl
#
# 用法：
#   ddns-home.sh           正常更新（cron 每 5 分钟）
#   ddns-home.sh --force   强制对账一次（不看缓存/时间窗）

DOMAIN="${DOMAIN:-graycarl.me}"
SUB_DOMAIN="${SUB_DOMAIN:-home}"
RECORD_TYPE="${RECORD_TYPE:-A}"
RECORD_TTL="${RECORD_TTL:-600}"
API_HOST="dnsapi.cn"

TOKEN_FILE="/jffs/.dnspod"
STATE_FILE="/jffs/.ddns-home.state"
LOG_FILE="/jffs/.ddns-home.log"
LOG_MAX_BYTES=200000
RECONCILE_SECS=86400

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

LOCK_DIR=/var/lock/ddns-home.lock

log() {
    echo "$(date '+%F %T') $*" >> "$LOG_FILE"
    if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
        tail -c 100000 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv -f "$LOG_FILE.tmp" "$LOG_FILE"
    fi
}

is_ipv4() {
    case "${1:-}" in
        ''|*[!0-9.]*) return 1 ;;
    esac
    _n=0
    for _o in $(echo "$1" | tr '.' ' '); do
        if [ "$_o" -ge 0 ] 2>/dev/null && [ "$_o" -le 255 ] 2>/dev/null; then :; else return 1; fi
        _n=$((_n + 1))
    done
    [ "$_n" -eq 4 ]
}

# ------------------------------------------------------------------ HTTPS 基础
# 把响应头剥掉，只留 body（顺便去掉 CR，兼容 chunked 的分块行）
strip_headers() {
    tr -d '\r' | awk 'p{print} /^$/{p=1}'
}

https_get() { # $1=host $2=path
    printf 'GET %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: fgw-ddns/1.0\r\nConnection: close\r\n\r\n' \
        "$2" "$1" \
        | openssl s_client -quiet -connect "$1:443" -servername "$1" 2>/dev/null \
        | strip_headers
}

api_post() { # $1=path $2=form body
    _len=$(printf '%s' "$2" | wc -c | tr -d ' ')
    printf 'POST %s HTTP/1.0\r\nHost: %s\r\nUser-Agent: fgw-ddns/1.0\r\nAccept: application/json\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
        "$1" "$API_HOST" "$_len" "$2" \
        | openssl s_client -quiet -connect "$API_HOST:443" -servername "$API_HOST" 2>/dev/null \
        | strip_headers
}

# ------------------------------------------------------------------ 状态文件
read_state() {
    CUR_IP=""
    CUR_RID=""
    LAST_RECONCILE=0
    [ -f "$STATE_FILE" ] || return 0
    CUR_IP=$(cut -d' ' -f1 "$STATE_FILE" 2>/dev/null | tr -d ' \r\n')
    CUR_RID=$(cut -d' ' -f2 "$STATE_FILE" 2>/dev/null | tr -d ' \r\n')
    LAST_RECONCILE=$(cut -d' ' -f3 "$STATE_FILE" 2>/dev/null | tr -d ' \r\n')
    case "$LAST_RECONCILE" in
        ''|*[!0-9]*) LAST_RECONCILE=0 ;;
    esac
    is_ipv4 "$CUR_IP" || CUR_IP=""
    case "$CUR_RID" in
        ''|*[!0-9]*) CUR_RID="" ;;
    esac
}

write_state() {
    echo "$1 $2 $3" > "$STATE_FILE"
    chmod 600 "$STATE_FILE" 2>/dev/null
}

# ------------------------------------------------------------------ 探测 IPv4
probe_ipv4() {
    _ip=$(https_get ipv4.icanhazip.com / | tail -1 | tr -d ' \r\n')
    is_ipv4 "$_ip" || _ip=$(https_get api.ipify.org / | tail -1 | tr -d ' \r\n')
    is_ipv4 "$_ip" && echo "$_ip"
}

# ------------------------------------------------------------------ DNSPod API
resolve_rid() {
    _resp=$(api_post /Record.List "login_token=$TOKEN&format=json&domain=$DOMAIN&sub_domain=$SUB_DOMAIN&record_type=$RECORD_TYPE")
    echo "$_resp" | grep -q '"code":"1"' || return 1
    # 截到 records 数组之后，取第一个记录 id（避免误抓 domain.id）
    echo "$_resp" \
        | sed -n 's/.*"records":\[//p' \
        | grep -o '"id":"[0-9]\{1,\}"' \
        | head -1 \
        | tr -dc '0-9'
}

fetch_remote_value() {
    _resp=$(api_post /Record.Info "login_token=$TOKEN&format=json&domain=$DOMAIN&record_id=$CUR_RID")
    echo "$_resp" | grep -q '"code":"1"' || return 1
    echo "$_resp" | sed -n 's/.*"value":"\([0-9.]\{7,\}\)".*/\1/p'
}

describe_change() {
    if [ "$1" = "$CUR_IP" ]; then
        echo "DNS reconciled: $1"
    else
        echo "DNS updated: ${CUR_IP:-<none>} -> $1"
    fi
}

# 更新 A 记录：优先 Record.Ddns（DDNS 专用接口），失败退回 Record.Modify
ddns_update() {
    _ip="$1"
    _resp=$(api_post /Record.Ddns "login_token=$TOKEN&format=json&domain=$DOMAIN&record_id=$CUR_RID&sub_domain=$SUB_DOMAIN&record_type=$RECORD_TYPE&record_line_id=0&value=$_ip&ttl=$RECORD_TTL")
    if echo "$_resp" | grep -q '"code":"1"'; then
        log "$(describe_change "$_ip") (record $CUR_RID)"
        return 0
    fi

    _resp=$(api_post /Record.Modify "login_token=$TOKEN&format=json&domain=$DOMAIN&record_id=$CUR_RID&sub_domain=$SUB_DOMAIN&record_type=$RECORD_TYPE&record_line_id=0&value=$_ip&ttl=$RECORD_TTL")
    if echo "$_resp" | grep -q '"code":"1"'; then
        log "$(describe_change "$_ip") via Modify (record $CUR_RID)"
        return 0
    fi

    log "ERROR update failed: $(echo "$_resp" | tr -d '\n' | cut -c1-200)"
    return 1
}

# ------------------------------------------------------------------ 并发锁
# firewall-start(每分钟) 与 ddns_home(每 5 分钟) 会在整点同时触发本脚本
acquire_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo $$ > "$LOCK_DIR/pid"
        trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
        return 0
    fi
    if [ -n "$(find "$LOCK_DIR" -mmin +10 2>/dev/null)" ]; then
        rm -rf "$LOCK_DIR"
        if mkdir "$LOCK_DIR" 2>/dev/null; then
            echo $$ > "$LOCK_DIR/pid"
            trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
            return 0
        fi
    fi
    return 1
}

main() {
    acquire_lock || exit 0

    [ -f "$TOKEN_FILE" ] || { log "ERROR: $TOKEN_FILE missing"; exit 1; }
    TOKEN=$(tr -d '\r\n' < "$TOKEN_FILE")

    read_state

    if [ -z "$CUR_RID" ]; then
        CUR_RID=$(resolve_rid)
        if [ -z "$CUR_RID" ]; then
            log "ERROR: record_id not found for $SUB_DOMAIN.$DOMAIN"
            exit 1
        fi
        log "resolved record_id=$CUR_RID"
    fi

    NOW=$(date +%s)
    CAND=$(nvram get wan0_ipaddr 2>/dev/null | tr -d ' \r\n')

    # 快路径：WAN IP 未变 + 距上次对账不足 24h → 直接退出（零网络请求）
    if [ "$FORCE" -eq 0 ] && is_ipv4 "$CAND" && [ "$CAND" = "$CUR_IP" ] \
        && [ $((NOW - LAST_RECONCILE)) -lt "$RECONCILE_SECS" ]; then
        exit 0
    fi

    if is_ipv4 "$CAND" && [ "$CAND" = "$CUR_IP" ]; then
        IPV4="$CAND"                       # 仅对账场景，无需探测
    else
        IPV4=$(probe_ipv4)                 # WAN 变化或 nvram 异常 → 实测出口 IPv4
        if ! is_ipv4 "$IPV4"; then
            if is_ipv4 "$CAND"; then
                IPV4="$CAND"
            else
                log "ERROR cannot determine WAN IPv4 (nvram='$CAND')"
                exit 1
            fi
        fi
    fi

    if [ "$IPV4" != "$CUR_IP" ]; then
        if ddns_update "$IPV4"; then
            write_state "$IPV4" "$CUR_RID" "$NOW"
            exit 0
        fi
        # 可能是 record_id 过期（记录被删后重建），重新发现后重试一次
        NEW_RID=$(resolve_rid)
        if [ -n "$NEW_RID" ] && [ "$NEW_RID" != "$CUR_RID" ]; then
            log "record_id changed $CUR_RID -> $NEW_RID, retry"
            CUR_RID="$NEW_RID"
            if ddns_update "$IPV4"; then
                write_state "$IPV4" "$CUR_RID" "$NOW"
                exit 0
            fi
        fi
        exit 1
    fi

    # IP 未变：按需与远端对账，纠正被外部改动/失效的记录
    if [ "$FORCE" -eq 1 ] || [ $((NOW - LAST_RECONCILE)) -ge "$RECONCILE_SECS" ]; then
        REMOTE=$(fetch_remote_value)
        if [ -z "$REMOTE" ]; then
            NEW_RID=$(resolve_rid)
            if [ -n "$NEW_RID" ] && [ "$NEW_RID" != "$CUR_RID" ]; then
                log "record_id changed $CUR_RID -> $NEW_RID"
                CUR_RID="$NEW_RID"
                REMOTE=$(fetch_remote_value)
            fi
        fi
        if [ -n "$REMOTE" ] && [ "$REMOTE" != "$IPV4" ]; then
            log "drift detected: remote=$REMOTE local=$IPV4"
            ddns_update "$IPV4" || exit 1
        fi
        write_state "$IPV4" "$CUR_RID" "$NOW"
    fi

    exit 0
}

main "$@"
