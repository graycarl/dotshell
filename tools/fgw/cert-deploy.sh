#!/bin/sh
# 把 /jffs/.cert 下的证书装进 /etc 并让 httpd 生效（运行在 Asuswrt 路由器上）
#
# 调用方：
#   - acme.sh --install-cert 的 --reloadcmd（续期成功后自动部署）
#   - /jffs/scripts/fgw-extra（开机 / 每分钟自愈时会调用，内部做了幂等短路）
#
# 机制说明（固件 3.0.0.6 + /usr/sbin/gencert.sh）：
#   le_enable=2 表示「使用上传的证书」，gencert.sh 会把
#   /jffs/.cert/cert.pem、/jffs/.cert/key.pem 覆盖到 /etc/cert.pem、/etc/key.pem
#   并在开机时自动还原，所以固件不会再拿自签证书覆盖我们。

CRT=/jffs/.cert/cert.pem
KEY=/jffs/.cert/key.pem
LOG=/jffs/.acme-home.log

log() { echo "$(date '+%F %T') [cert-deploy] $*" >> "$LOG"; }

[ -s "$CRT" ] && [ -s "$KEY" ] || { log "skip: $CRT 或 $KEY 不存在"; exit 0; }

LE=$(nvram get le_enable 2>/dev/null)
if [ "$LE" != "2" ]; then
    nvram set le_enable=2 >/dev/null 2>&1
    nvram commit >/dev/null 2>&1
    log "set le_enable=2（使用上传证书，避免固件重签自签证书）"
fi

# 幂等：/etc 里已经是同一张证书且模式正确 → 什么都不做（避免每分钟重启 httpd）
if [ "$LE" = "2" ] && cmp -s "$CRT" /etc/cert.pem; then
    exit 0
fi

# 证书与私钥必须配对，否则宁可不装（装错了 WebUI 会无法访问）
if which openssl >/dev/null 2>&1; then
    _a=$(openssl x509 -noout -pubkey -in "$CRT" 2>/dev/null | openssl md5 2>/dev/null)
    _b=$(openssl pkey -pubout -in "$KEY" 2>/dev/null | openssl md5 2>/dev/null)
    if [ -n "$_a" ] && [ "$_a" != "$_b" ]; then
        log "ERROR cert/key 不匹配，放弃部署"
        exit 1
    fi
fi

# gencert.sh -l 1：还原 /jffs/.cert 里的证书并通知 httpd reload
/usr/sbin/gencert.sh -l 1 >/dev/null 2>&1 || true

# 双保险：确保 /etc 里就是我们的证书，然后重启 httpd
cp -f "$CRT" /etc/cert.pem 2>/dev/null || true
cp -f "$KEY" /etc/key.pem 2>/dev/null || true
service restart_httpd >/dev/null 2>&1 || true

log "deployed: $(openssl x509 -noout -subject -issuer -enddate -in "$CRT" 2>/dev/null | tr '\n' ' ')"
exit 0
