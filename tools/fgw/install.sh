#!/usr/bin/env bash
# 在路由器上安装「DNSPod DDNS + Let's Encrypt 证书」（Mac 侧一键执行，幂等）
#
# 做的事：
#   1. 把路由器侧脚本推到 /jffs/scripts/（ddns-home.sh / cert-deploy.sh / acme-renew.sh / fgw-extra）
#   2. 写 /jffs/.dnspod（token，权限 600）与 DDNS 状态文件
#   3. 给内置 acme.sh 补 dnsapi/dns_dp.sh 插件
#   4. 用 DNS-01 签发 home.graycarl.me 证书（不依赖 80/443 入站）
#   5. 切到 le_enable=2（使用上传证书），部署到 /etc 并重启 httpd
#   6. 注册 cru 任务（DDNS 每 5 分钟 / 续期每天）+ 自检
#
# 用法：
#   ~/.shell/tools/fgw/install.sh                  # 全量（幂等，可反复跑）
#   ~/.shell/tools/fgw/install.sh --skip-cert      # 只装 DDNS
#   ~/.shell/tools/fgw/install.sh --skip-ddns      # 只装证书
#
# 可覆盖的环境变量：ROUTER_USER / ROUTER_HOST / ROUTER_SSH_PORT / DOMAIN / SUB_DOMAIN
#                  DNSPOD_TOKEN（默认从 ~/.config/hbkit/hbkit.ini 读取）

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

ROUTER_USER="${ROUTER_USER:-hongbo}"
ROUTER_HOST="${ROUTER_HOST:-192.168.50.1}"
ROUTER_SSH_PORT="${ROUTER_SSH_PORT:-22}"

DOMAIN="${DOMAIN:-graycarl.me}"
SUB_DOMAIN="${SUB_DOMAIN:-home}"
FQDN="$SUB_DOMAIN.$DOMAIN"

HBCONF="${HBCONF:-$HOME/.config/hbkit/hbkit.ini}"
ACME_HOME="/jffs/acme"
DNS_PLUGIN_URL="https://raw.githubusercontent.com/acmesh-official/acme.sh/master/dnsapi/dns_dp.sh"

SKIP_CERT=0
SKIP_DDNS=0
for arg in "$@"; do
  case "$arg" in
    --skip-cert) SKIP_CERT=1 ;;
    --skip-ddns) SKIP_DDNS=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10 -p "$ROUTER_SSH_PORT")

log()  { printf '\n\033[1m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

ssh_r() { ssh "${SSH_OPTS[@]}" "${ROUTER_USER}@${ROUTER_HOST}" "$@"; }

push_file() { # $1=本地文件 $2=远端路径 $3=权限
  ssh_r "cat > '$2'" < "$1"
  ssh_r "chmod '$3' '$2'" >/dev/null
}

# ---------------------------------------------------------------- 0. 前置检查
log "0/7 前置检查"
TOKEN="${DNSPOD_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HBCONF" ]]; then
  TOKEN="$(sed -n 's/^[[:space:]]*token[[:space:]]*=[[:space:]]*//p' "$HBCONF" | head -1 | tr -d '\r')"
fi
[[ -n "$TOKEN" ]] || die "未找到 DNSPod token（$HBCONF 里 [dnspod] token，或用 DNSPOD_TOKEN 传入）"
[[ "$TOKEN" =~ ^[0-9]+,[0-9a-zA-Z]+$ ]] || die "DNSPod token 格式异常（应为 <ID>,<Token>）"
ok "token 已读取（${TOKEN%%,*},****）"

ssh_r 'true' || die "SSH 连不上 ${ROUTER_USER}@${ROUTER_HOST}"
ok "SSH 可达 ${ROUTER_HOST}"

# ---------------------------------------------------------------- 1. 推送脚本
if [[ "$SKIP_DDNS" -eq 0 || "$SKIP_CERT" -eq 0 ]]; then
  log "1/7 推送路由器脚本到 /jffs/scripts/"
  for f in ddns-home.sh cert-deploy.sh acme-renew.sh fgw-extra; do
    push_file "$HERE/$f" "/jffs/scripts/$f" 755
    ok "$f"
  done
fi

# ---------------------------------------------------------------- 2. token + 状态
if [[ "$SKIP_DDNS" -eq 0 ]]; then
  log "2/7 写入 /jffs/.dnspod 并初始化 DDNS 状态"
  ssh_r 'umask 077; cat > /jffs/.dnspod' <<<"$TOKEN"
  ssh_r 'chmod 600 /jffs/.dnspod' >/dev/null
  ok "token 已写入（600）"

  RID="$(curl -s --max-time 15 -X POST https://dnsapi.cn/Record.List \
      -d "login_token=$TOKEN" -d "format=json" -d "domain=$DOMAIN" \
      -d "sub_domain=$SUB_DOMAIN" -d "record_type=A" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["records"][0]["id"])' 2>/dev/null || true)"
  [[ -n "$RID" ]] || die "DNSPod 里找不到 $SUB_DOMAIN.$DOMAIN 的 A 记录（请先在 DNSPod 建好）"
  REMOTE_IP="$(curl -s --max-time 15 -X POST https://dnsapi.cn/Record.Info \
      -d "login_token=$TOKEN" -d "format=json" -d "domain=$DOMAIN" -d "record_id=$RID" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["record"]["value"])' 2>/dev/null || true)"
  ok "record_id=${RID}，当前记录值=${REMOTE_IP:-?}"

  # 只在状态文件不存在时初始化，避免重启后把已知 IP 清空
  ssh_r "test -s /jffs/.ddns-home.state || echo '${REMOTE_IP:-} $RID 0' > /jffs/.ddns-home.state"
  ssh_r 'chmod 600 /jffs/.ddns-home.state' >/dev/null
  ok "状态文件就绪"

  log "2b/7 立即执行一次 DDNS 校验"
  ssh_r '/jffs/scripts/ddns-home.sh --force' || warn "DDNS 首次执行返回非 0，请查看 /jffs/.ddns-home.log"
  ssh_r 'tail -3 /jffs/.ddns-home.log 2>/dev/null' | sed 's/^/  /' || true
fi

# ---------------------------------------------------------------- 3. acme.sh 插件
if [[ "$SKIP_CERT" -eq 0 ]]; then
  log "3/7 安装 acme.sh 的 DNSPod DNS-01 插件"
  ssh_r "mkdir -p $ACME_HOME/dnsapi && chmod 700 $ACME_HOME"
  if ssh_r "test -s $ACME_HOME/dnsapi/dns_dp.sh"; then
    ok "已存在，跳过"
  else
    if ssh_r "curl -sfLo $ACME_HOME/dnsapi/dns_dp.sh '$DNS_PLUGIN_URL'"; then
      ok "路由器直接下载成功"
    else
      warn "路由器下载失败，改由 Mac 下载后推送"
      tmp="$(mktemp)"
      curl -sfLo "$tmp" "$DNS_PLUGIN_URL" || die "Mac 也下载不到 $DNS_PLUGIN_URL"
      push_file "$tmp" "$ACME_HOME/dnsapi/dns_dp.sh" 755
      rm -f "$tmp"
      ok "已推送插件"
    fi
  fi

  # ------------------------------------------------------------- 4. 签发证书
  log "4/7 签发证书（DNS-01 / Let's Encrypt / ec-256）"
  set +e
  ssh_r "DP_Id=\$(cut -d, -f1 /jffs/.dnspod) DP_Key=\$(cut -d, -f2 /jffs/.dnspod) \
        sh /usr/sbin/acme.sh --home $ACME_HOME --issue --dns dns_dp \
        -d '$FQDN' --keylength ec-256 --server letsencrypt" 2>&1 | tail -20 | sed 's/^/  /'
  issue_rc=$?
  set -e
  # acme.sh 在「未到续期时间」时返回 2，属正常
  if [[ "$issue_rc" -ne 0 && "$issue_rc" -ne 2 ]]; then
    warn "acme.sh --issue 返回 ${issue_rc}，继续尝试部署（若证书不存在会失败）"
  fi

  log "5/7 安装证书到 /jffs/.cert 并切 le_enable=2"
  ssh_r "mkdir -p /jffs/.cert && chmod 700 /jffs/.cert"
  ssh_r "sh /usr/sbin/acme.sh --home $ACME_HOME --install-cert -d '$FQDN' --ecc \
        --key-file /jffs/.cert/key.pem \
        --fullchain-file /jffs/.cert/cert.pem \
        --reloadcmd '/jffs/scripts/cert-deploy.sh'" 2>&1 | tail -8 | sed 's/^/  /'
  ssh_r 'chmod 600 /jffs/.cert/key.pem; chmod 644 /jffs/.cert/cert.pem' >/dev/null || true

  ssh_r 'nvram set le_enable=2; nvram commit' >/dev/null 2>&1
  ok "le_enable=2（固件不再重签自签证书）"

  ssh_r '/jffs/scripts/cert-deploy.sh' || warn "cert-deploy.sh 返回非 0"
  ssh_r 'tail -2 /jffs/.acme-home.log 2>/dev/null' | sed 's/^/  /' || true
fi

# ---------------------------------------------------------------- 6. 定时任务
log "6/7 注册定时任务"
ssh_r '/jffs/scripts/fgw-extra' >/dev/null 2>&1 || true
ssh_r "cru d ddns_home >/dev/null 2>&1; cru d acme_renew >/dev/null 2>&1; \
       cru a ddns_home '*/5 * * * * /jffs/scripts/ddns-home.sh >/dev/null 2>&1' >/dev/null 2>&1; \
       cru a acme_renew '43 4 * * * /jffs/scripts/acme-renew.sh >/dev/null 2>&1' >/dev/null 2>&1"
ssh_r 'cru l 2>/dev/null | grep -E "ddns_home|acme_renew"' | sed 's/^/  /'

# ---------------------------------------------------------------- 7. 校验
log "7/7 校验"
HTTPS_PORT="$(ssh_r 'nvram get https_lanport' | tr -d '\r\n')"
HTTPS_PORT="${HTTPS_PORT:-8443}"
if [[ "$SKIP_CERT" -eq 0 ]]; then
  ssh_r "openssl s_client -connect 127.0.0.1:$HTTPS_PORT -servername $FQDN </dev/null 2>/dev/null \
         | openssl x509 -noout -subject -issuer -enddate" 2>/dev/null | sed 's/^/  /' || warn "https 证书读取失败"
fi
if [[ "$SKIP_DDNS" -eq 0 ]]; then
  sleep 1
  echo "  DNS 记录：$(dig +short "$FQDN" A @f1g1ns1.dnspod.net 2>/dev/null | head -1) (权威) / $(dig +short "$FQDN" A 2>/dev/null | head -1) (本地缓存)"
  echo "  路由器 WAN IPv4：$(ssh_r 'nvram get wan0_ipaddr' | tr -d '\r\n')"
fi

log "完成"
cat <<EOF
  访问方式：https://$FQDN:$HTTPS_PORT/   （局域网内可配合 /etc/hosts 或内网 DNS）
  日志：
    路由器 /jffs/.ddns-home.log     DDNS
    路由器 /jffs/.acme-home.log     证书续期 + 部署
    路由器 /jffs/.ddns-home.state   "<ip> <record_id> <last_reconcile_epoch>"
  续期：cru 每天 04:43 跑 acme.sh --cron，成功后续期脚本自动部署并重启 httpd
  注意：该固件 crond 会话里 curl/wget 静默失效，acme-renew.sh 会自动脱离会话重跑
  注意：固件升级/恢复出厂会清 /jffs，重跑本脚本即可恢复
EOF
