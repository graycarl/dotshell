#!/usr/bin/env bash
set -euo pipefail

# ===== 可按需覆盖的环境变量 =====
ROUTER_USER="${ROUTER_USER:-hongbo}"
ROUTER_HOST="${ROUTER_HOST:-192.168.50.1}"
ROUTER_SSH_PORT="${ROUTER_SSH_PORT:-22}"

WG_SUBNET="${WG_SUBNET:-10.6.0.0/24}"
WG_TEST_IP="${WG_TEST_IP:-10.6.0.2}"
LAN_SUBNET="${LAN_SUBNET:-192.168.50.0/24}"
LAN_IF="${LAN_IF:-br0}"
SURGE_IP="${SURGE_IP:-192.168.50.10}"
ROUTER_LAN_IP="${ROUTER_LAN_IP:-192.168.50.1}"
SNAT_IP="${SNAT_IP:-192.168.50.1}"
TABLE_ID="${TABLE_ID:-100}"
CRU_TAG="${CRU_TAG:-wg_surge}"

SSH_OPTS=(
  -o StrictHostKeyChecking=no
  -o ConnectTimeout=8
  -p "$ROUTER_SSH_PORT"
)

log() {
  printf '\n[%s] %s\n' "$(date '+%F %T')" "$*"
}

configure_router() {
  log "配置路由器规则与持久化（${ROUTER_USER}@${ROUTER_HOST}）"

  ssh "${SSH_OPTS[@]}" "${ROUTER_USER}@${ROUTER_HOST}" \
    sh -s -- \
    "$WG_SUBNET" "$LAN_SUBNET" "$LAN_IF" "$SURGE_IP" "$SNAT_IP" "$TABLE_ID" "$CRU_TAG" <<'REMOTE'
set -eu

WG_SUBNET="$1"
LAN_SUBNET="$2"
LAN_IF="$3"
SURGE_IP="$4"
SNAT_IP="$5"
TABLE_ID="$6"
CRU_TAG="$7"

mkdir -p /jffs/scripts

cat > /jffs/scripts/firewall-start <<EOF
#!/bin/sh
WG_SUBNET='$WG_SUBNET'
LAN_SUBNET='$LAN_SUBNET'
LAN_IF='$LAN_IF'
SURGE_IP='$SURGE_IP'
SNAT_IP='$SNAT_IP'
TABLE_ID='$TABLE_ID'

logger -t wg-surge 'firewall-start begin'

# 等待 LAN 接口可用
for i in 1 2 3 4 5 6 7 8 9 10; do
  ip link show "\$LAN_IF" >/dev/null 2>&1 && break
  sleep 1
done

# 可选：表名映射
if [ -f /etc/iproute2/rt_tables ]; then
  grep -qE '^[[:space:]]*100[[:space:]]+surge$' /etc/iproute2/rt_tables || echo '100 surge' >> /etc/iproute2/rt_tables
fi

# 幂等清理
while ip rule del from "\$WG_SUBNET" table "\$TABLE_ID" 2>/dev/null; do :; done
ip route flush table "\$TABLE_ID" 2>/dev/null
while iptables -t nat -D POSTROUTING -s "\$WG_SUBNET" -o "\$LAN_IF" ! -d "\$LAN_SUBNET" -j SNAT --to-source "\$SNAT_IP" 2>/dev/null; do :; done

# 重建策略路由
ip rule add from "\$WG_SUBNET" table "\$TABLE_ID"
ip route add "\$LAN_SUBNET" dev "\$LAN_IF" table "\$TABLE_ID"
ip route add default via "\$SURGE_IP" dev "\$LAN_IF" table "\$TABLE_ID"

# WG -> Surge 前 SNAT（确保回程稳定）
iptables -t nat -I POSTROUTING 1 -s "\$WG_SUBNET" -o "\$LAN_IF" ! -d "\$LAN_SUBNET" -j SNAT --to-source "\$SNAT_IP"

logger -t wg-surge 'firewall-start applied'
EOF

chmod +x /jffs/scripts/firewall-start

# 官方 ROM 上 firewall-start hook 可能不触发，用 cru 做自愈持久化
if command -v cru >/dev/null 2>&1; then
  cru d "$CRU_TAG" >/dev/null 2>&1 || true
  cru a "$CRU_TAG" "*/1 * * * * /jffs/scripts/firewall-start >/dev/null 2>&1"
fi

# 尽量开启 jffs 脚本开关（对官方 ROM 不一定生效）
CUR="$(nvram get jffs2_scripts 2>/dev/null || true)"
if [ "${CUR:-0}" != "1" ]; then
  nvram set jffs2_scripts=1 >/dev/null 2>&1 || true
  nvram commit >/dev/null 2>&1 || true
fi

# 立即生效一次
/jffs/scripts/firewall-start

echo '[router] DONE'
ip rule show | grep -E '10\.6\.0\.0/24|lookup surge|lookup 100' || true
ip route show table 100 || true
iptables -t nat -L POSTROUTING -n --line-numbers | head -8 || true
cru l 2>/dev/null | grep "$CRU_TAG" || true
REMOTE
}

configure_mac_route() {
  log "配置 Mac 静态路由（幂等）"

  current_gateway="$(route -n get "$WG_TEST_IP" 2>/dev/null | awk '/gateway:/{print $2; exit}' || true)"

  if [[ "$current_gateway" == "$ROUTER_LAN_IP" ]]; then
    log "Mac 路由已正确：${WG_SUBNET} -> ${ROUTER_LAN_IP}"
  else
    log "更新 Mac 路由：${WG_SUBNET} -> ${ROUTER_LAN_IP}"
    sudo route -n delete -net "$WG_SUBNET" >/dev/null 2>&1 || true
    sudo route -n add -net "$WG_SUBNET" "$ROUTER_LAN_IP" >/dev/null
  fi

  route -n get "$WG_TEST_IP" | sed -n '1,8p'
}

main() {
  log "开始执行 gfw/start.sh"
  configure_router
  configure_mac_route
  log "全部完成（可重复执行）"
}

main "$@"
