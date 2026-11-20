#!/usr/bin/env bash
#
# appstore-switch.sh — 一键切换 macOS App Store（媒体与购买项目）账号
#
# 为什么需要它：Apple 没有提供任何命令行 / API 来切换 App Store 账号，
# 唯一可行路径是用 Accessibility UI 自动化驱动 App Store 自身的
# 「退出登录 / 登录」流程。本脚本就是这层自动化。
#
# 实测结论（macOS 26.x，系统语言=简体中文，账号地区 CN + CA）：
#   * 菜单栏 item 名是本地化的，而且**会跟着 storefront 变**：CN 账号是
#     商店/账户/退出登录，CA 账号是 Store/Account/Sign Out。菜单项没有稳定的
#     AXIdentifier，所以全部按「中/英候选名」匹配，不写死任何一种。
#   * window 的 `entire contents` 在账号页（WebView 实现）上会遍历到超时，
#     禁止使用；一律走定向查询 / 有界递归。
#   * 侧栏第一个有名字的直接子级 button = 当前账号显示名（未登录时是「登录」，
#     CA 账号会带余额如 "Hongbo He, $7.93"，比对前要剥掉余额）。
#   * 登录面板分两步：先 Apple ID（预填上次用过的账号），点「登录」后同一个
#     sheet 里出现安全文本栏（密码）。
#   * 双重认证的 6 格验证码框用 AX set value 写不进去（写进去立刻被清空），
#     只有真实键盘事件才能触发提交 —— 所以本脚本不接管，提示你在面板里手输。
#   * 验证码通过后可能再弹「Welcome to the App Store / 欢迎使用」引导页，
#     必须点掉，否则菜单里没有「退出登录」，看起来像没登上。
#   * 输入一律用 AX set value（Apple ID / 密码都实测有效），不用合成键盘事件：
#     后者需要「辅助功能」权限，前者只需要「自动化（控制 System Events）」权限。
#   * 读不到当前登录的 Apple ID 邮箱：~/Library/Accounts 受 TCC 保护、
#     com.apple.commerce.plist 是空的。所以「是否已是目标账号」用 state 文件记录的
#     (alias, 显示名) 双确认；不一致时视为「不确定」照常切换，--force 可强制。
#
# 凭据处理：密码只存在钥匙串（service = appstore-<alias>），由 set-password 写入；
#   本脚本读取后经 argv 传给 osascript —— 不落盘、不 echo、不进 shell history。
#   注意 argv 在进程存活期对 `ps` 可见（毫秒级），这是已知且接受的取舍。
#
# 配置：$XDG_CONFIG_HOME/appstore/accounts.conf（默认 ~/.config/appstore/）
# 状态：同目录 state（记录上次成功切换到的 alias + 显示名 + 时间）
#
# 用法见 --help。
#
# shellcheck disable=SC2016,SC2086

set -uo pipefail

CONF_DIR=${APPSTORE_CONF_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/appstore}
CONF=$CONF_DIR/accounts.conf
STATE=$CONF_DIR/state
TIMEOUT=${APPSTORE_TIMEOUT:-60}
KEYCHAIN_PREFIX=${APPSTORE_KEYCHAIN_PREFIX:-appstore}

RED='' GREEN='' YELLOW='' BLUE='' NC=''
if [[ -t 1 ]]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
fi

info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$NC" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$RED" "$NC" "$*" >&2; exit 1; }
step() { printf '%s▸%s %s\n' "$BLUE" "$NC" "$*"; }

usage() {
    cat <<'USAGE'
用法: appstore-switch.sh <命令> [参数]

命令:
  status                  显示当前 App Store 登录状态（读侧栏显示名 + state 记录）
  list                    列出 accounts.conf 里配置的账号（* = state 记录的当前账号）
  switch <alias>          切换到指定账号（登出 → 登录，凭据走钥匙串）
                          双重认证需要你在弹出的面板里手输 6 位验证码
  set-password <alias>    交互式把密码写入钥匙串（不回显、不进 history）
  dump-ax                 排错用：打印 App Store 及各弹窗的定向 AX 结构
  help                    显示本帮助

switch 选项:
  -y, --yes               跳过执行前确认
  -n, --dry-run           只打印将要执行的步骤，不做任何 UI 操作
      --force             即使 state 显示已是该账号也重新切换
      --manual-password   不从钥匙串取密码，由你在弹窗里手动输入
      --manual-id         只把你送到登录面板并填好 Apple ID，剩下的手动完成
      --timeout <秒>      每一步等待 UI 出现的超时，默认 60

配置文件: ~/.config/appstore/accounts.conf
  # alias  apple_id            region
  cn       xxx@qq.com          CN
  ca       xxx@icloud.com      CA

state 文件: ~/.config/appstore/state（脚本自己维护，别手改）

依赖: macOS 自带 osascript / security。
      首次运行会请求「自动化」权限（允许终端控制 System Events）——
      不需要「辅助功能」权限，脚本不发合成键盘事件。
USAGE
}

# ---------------------------------------------------------------- AppleScript 层
#
# 所有 AX 操作都通过一个常驻的临时 AppleScript 文件分发（op + argv），
# 避免每次在 bash 里拼接多行脚本字符串。
# 传值一律走 argv：密码/验证码里含任何引号、反斜杠都不会炸掉脚本。

AS_FILE=''
AS_TMPDIR=''

as_init() {
    AS_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/appstore-switch.XXXXXX") || die "无法创建临时目录"
    AS_FILE=$AS_TMPDIR/ax.applescript
    cat >"$AS_FILE" <<'APPLESCRIPT'
-- 找到「商店 / Store」菜单栏项的名字（本地化无关）
on storeMenuName()
    tell application "System Events"
        if not (exists process "App Store") then return ""
        tell process "App Store"
            if (count of windows) is 0 then return ""
            repeat with nm in {"商店", "Store"}
                try
                    if exists menu bar item (nm as text) of menu bar 1 then return nm as text
                end try
            end repeat
        end tell
    end tell
    return ""
end storeMenuName

-- 侧栏第一个有名字的直接子级 button 的名字 = 当前账号显示名（未登录时是「登录」）
on displayName()
    set disp to ""
    tell application "System Events" to tell process "App Store"
        try
            repeat with b in (buttons of splitter group 1 of window 1)
                try
                    set n to (name of b) as text
                    if n is not "" then set disp to n
                end try
            end repeat
        end try
    end tell
    return disp
end displayName

on menuHas(wants)
    set mn to my storeMenuName()
    if mn is "" then return false
    tell application "System Events" to tell process "App Store"
        repeat with want in wants
            try
                if exists menu item (want as text) of menu 1 of menu bar item mn of menu bar 1 then return true
            end try
        end repeat
    end tell
    return false
end menuHas

-- 有界递归找按钮：登录面板的按钮藏在 sheet/sheet 里，
-- 而且 SwiftUI 层级很深，所以按深度上限递归，匹配 title 或 name。
property doneCount : 0

on findButtonIn(elem, wants, dpt, acc)
    if acc is not missing value then return acc
    if dpt > 8 then return acc
    if my elemRole(elem) is "AXButton" then
        set t to my attrOf(elem, "title")
        set n to my attrOf(elem, "name")
        repeat with want in wants
            set w to want as text
            if t is w or n is w then return elem
        end repeat
    end if
    repeat with k in my elemKids(elem)
        set acc to my findButtonIn(k, wants, dpt + 1, acc)
        if acc is not missing value then return acc
    end repeat
    return acc
end findButtonIn

on clickButtonIn(procName, wants)
    set acc to missing value
    set hasProc to false
    tell application "System Events" to set hasProc to exists process procName
    if not hasProc then return ""
    set nWin to 0
    tell application "System Events" to tell process procName to set nWin to count of windows
    if nWin is 0 then return ""
    set nSheet to 0
    try
        tell application "System Events" to tell process procName to set nSheet to count of sheets of window 1
    end try
    if nSheet > 0 then
        set sh to my procSheet(procName)
        if sh is not missing value then set acc to my findButtonIn(sh, wants, 0, missing value)
    end if
    if acc is missing value then
        set w to my procWindow(procName)
        if w is not missing value then set acc to my findButtonIn(w, wants, 0, missing value)
    end if
    if acc is missing value then return ""
    try
        tell application "System Events" to click acc
    on error errMsg
        return "err:" & errMsg
    end try
    return my attrOf(acc, "title")
end clickButtonIn

on elemRole(elem)
    set r to "?"
    try
        tell application "System Events" to set r to (role of elem) as text
    end try
    return r
end elemRole

on elemKids(elem)
    set kids to {}
    try
        tell application "System Events" to set kids to (UI elements of elem)
    end try
    return kids
end elemKids

on isFieldRole(r)
    return (r is "AXTextField") or (r is "AXSecureTextField")
end isFieldRole

on procWindow(procName)
    set w to missing value
    try
        tell application "System Events"
            tell process procName
                set w to window 1
            end tell
        end tell
    end try
    return w
end procWindow

on procSheet(procName)
    set sh to missing value
    try
        tell application "System Events"
            tell process procName
                set sh to sheet 1 of window 1
            end tell
        end tell
    end try
    return sh
end procSheet

on collectFields(elem, pth, dpt, acc)
    if dpt > 6 then return acc
    if doneCount > 400 then return acc
    set r to my elemRole(elem)
    set doneCount to doneCount + 1
    if my isFieldRole(r) then
        set dsc to ""
        try
            tell application "System Events" to set dsc to (description of elem) as text
        end try
        set vv to ""
        try
            tell application "System Events" to set vv to (value of elem) as text
        end try
        set end of acc to pth & "|" & r & "|" & dsc & "|" & vv
        return acc
    end if
    repeat with k in my elemKids(elem)
        set acc to my collectFields(k, pth & "/" & r, dpt + 1, acc)
    end repeat
    return acc
end collectFields

-- 登录面板通常在 sheet 上，所以先遍历 sheet，再遍历 window
on fieldReport(procName)
    set doneCount to 0
    set acc to {}
    set hasProc to false
    tell application "System Events" to set hasProc to exists process procName
    if not hasProc then return acc
    set nWin to 0
    tell application "System Events" to tell process procName to set nWin to count of windows
    if nWin is 0 then return acc
    set nSheet to 0
    try
        tell application "System Events" to tell process procName to set nSheet to count of sheets of window 1
    end try
    if nSheet > 0 then
        set sh to my procSheet(procName)
        if sh is not missing value then set acc to my collectFields(sh, procName & "|sheet", 0, acc)
    else
        set w to my procWindow(procName)
        if w is not missing value then set acc to my collectFields(w, procName & "|win", 0, acc)
    end if
    return acc
end fieldReport

on collectFieldRefsIn(elem, dpt, acc)
    if dpt > 6 then return acc
    set r to my elemRole(elem)
    if my isFieldRole(r) then
        set end of acc to elem
        return acc
    end if
    repeat with k in my elemKids(elem)
        set acc to my collectFieldRefsIn(k, dpt + 1, acc)
    end repeat
    return acc
end collectFieldRefsIn

on collectTexts(elem, dpt, acc)
    if dpt > 8 then return acc
    if doneCount > 300 then return acc
    set doneCount to doneCount + 1
    set r to my elemRole(elem)
    if r is "AXStaticText" or r is "AXLink" then
        set vv to my attrOf(elem, "value")
        if vv is "" or vv is "missing value" then set vv to my attrOf(elem, "name")
        if vv is not "" and vv is not "missing value" then set end of acc to vv
    end if
    repeat with k in my elemKids(elem)
        set acc to my collectTexts(k, dpt + 1, acc)
    end repeat
    return acc
end collectTexts

on attrOf(elem, what)
    set v to ""
    try
        tell application "System Events"
            if what is "name" then set v to (name of elem) as text
            if what is "desc" then set v to (description of elem) as text
            if what is "title" then set v to (title of elem) as text
            if what is "value" then set v to (value of elem) as text
        end tell
    end try
    return v
end attrOf

-- 排错用：把 sheet（没有则 window）的 UI 树打出来，深度/数量都有上限
on walkTree(elem, dpt, acc)
    if dpt > 8 then return acc
    if doneCount > 300 then return acc
    set doneCount to doneCount + 1
    set r to my elemRole(elem)
    set line__ to ""
    repeat with i from 1 to dpt
        set line__ to line__ & "  "
    end repeat
    set line__ to line__ & r & " name='" & my attrOf(elem, "name") & "' desc='" & my attrOf(elem, "desc") & "' title='" & my attrOf(elem, "title") & "'"
    set vv to my attrOf(elem, "value")
    if vv is not "" then set line__ to line__ & " value='" & vv & "'"
    set end of acc to line__
    repeat with k in my elemKids(elem)
        set acc to my walkTree(k, dpt + 1, acc)
    end repeat
    return acc
end walkTree

-- 与 fieldReport 相同的遍历顺序（sheet 优先，再 window），但返回元素引用
on collectFieldRefs(procName, acc)
    set hasProc to false
    tell application "System Events" to set hasProc to exists process procName
    if not hasProc then return acc
    set nWin to 0
    tell application "System Events" to tell process procName to set nWin to count of windows
    if nWin is 0 then return acc
    set nSheet to 0
    try
        tell application "System Events" to tell process procName to set nSheet to count of sheets of window 1
    end try
    if nSheet > 0 then
        set sh to my procSheet(procName)
        if sh is not missing value then set acc to my collectFieldRefsIn(sh, 0, acc)
    else
        set w to my procWindow(procName)
        if w is not missing value then set acc to my collectFieldRefsIn(w, 0, acc)
    end if
    return acc
end collectFieldRefs

-- 主分发：argv[1] = op
on run argv
    set op to item 1 of argv
    if op is "state" then
        tell application "System Events"
            if not (exists process "App Store") then return "noapp" & tab & ""
            tell process "App Store"
                if (count of windows) is 0 then return "nowin" & tab & ""
            end tell
        end tell
        set mn to my storeMenuName()
        if mn is "" then return "nomenu" & tab & ""
        if my menuHas({"退出登录", "Sign Out"}) then
            return "signed_in" & tab & my displayName()
        else
            return "signed_out" & tab & my displayName()
        end if
    else if op is "clickmenu" then
        set mn to my storeMenuName()
        if mn is "" then return ""
        tell application "System Events" to tell process "App Store"
            repeat with i from 2 to (count of argv)
                set want to item i of argv
                try
                    if exists menu item want of menu 1 of menu bar item mn of menu bar 1 then
                        click menu item want of menu 1 of menu bar item mn of menu bar 1
                        return want
                    end if
                end try
            end repeat
        end tell
        return ""
    else if op is "activate" then
        tell application "System Events" to tell process "App Store" to set frontmost to true
        return "ok"
    else if op is "clickbutton" then
        set wants to items 2 thru -1 of argv
        -- 先 App Store，再当前前台进程（登录面板可能属于别的进程）
        set r to my clickButtonIn("App Store", wants)
        if r is not "" then return r
        set fp to ""
        tell application "System Events" to set fp to name of first process whose frontmost is true
        return my clickButtonIn(fp, wants)
    else if op is "fields" then
        set acc to my fieldReport("App Store")
        set fp to ""
        tell application "System Events" to set fp to name of first process whose frontmost is true
        if fp is not "App Store" and fp is not "" then
            set acc to acc & my fieldReport(fp)
        end if
        set AppleScript's text item delimiters to linefeed
        set s to acc as text
        set AppleScript's text item delimiters to ""
        return s
    else if op is "tree" then
        set doneCount to 0
        set acc to {}
        set nSheet to 0
        try
            tell application "System Events" to tell process "App Store" to set nSheet to count of sheets of window 1
        end try
        if nSheet > 0 then
            set sh to my procSheet("App Store")
            if sh is not missing value then set acc to my walkTree(sh, 0, acc)
        else
            set w to my procWindow("App Store")
            if w is not missing value then set acc to my walkTree(w, 0, acc)
        end if
        set AppleScript's text item delimiters to linefeed
        set s to acc as text
        set AppleScript's text item delimiters to ""
        return s
    else if op is "setfield" then
        -- argv[2] = 第 n 个 text field，argv[3] = 新值
        set n to (item 2 of argv) as integer
        set newVal to item 3 of argv
        set refs to {}
        set refs to my collectFieldRefs("App Store", refs)
        set fp to ""
        tell application "System Events" to set fp to name of first process whose frontmost is true
        if (count of refs) < n and fp is not "App Store" and fp is not "" then
            set refs to my collectFieldRefs(fp, refs)
        end if
        if (count of refs) < n then return "nofield"
        set el to item n of refs
        try
            tell application "System Events"
                set focused of el to true
            end tell
        end try
        try
            tell application "System Events"
                set value of el to newVal
            end tell
        on error errMsg
            return "err:" & errMsg
        end try
        return "ok"
    else if op is "texts" then
        set doneCount to 0
        set acc to {}
        set nSheet to 0
        try
            tell application "System Events" to tell process "App Store" to set nSheet to count of sheets of window 1
        end try
        if nSheet > 0 then
            set sh to my procSheet("App Store")
            if sh is not missing value then set acc to my collectTexts(sh, 0, acc)
        else
            set w to my procWindow("App Store")
            if w is not missing value then set acc to my collectTexts(w, 0, acc)
        end if
        set AppleScript's text item delimiters to linefeed
        set s2 to acc as text
        set AppleScript's text item delimiters to ""
        return s2
    else if op is "dump" then
        set out to "=== procs with windows ===" & linefeed
        tell application "System Events"
            repeat with p in (every process whose background only is false)
                try
                    if (count of windows of p) > 0 then
                        set out to out & "- " & (name of p) & " frontmost=" & (frontmost of p) & linefeed
                    end if
                end try
            end repeat
            set out to out & "=== App Store ===" & linefeed
            if exists process "App Store" then
                tell process "App Store"
                    set out to out & "menu=" & my storeMenuName() & " display=" & my displayName() & linefeed
                    repeat with w in windows
                        set out to out & "* window role=" & (role of w) & " subrole=" & (subrole of w) & " title=" & (name of w) & linefeed
                        try
                            repeat with b in (buttons of w)
                                set out to out & "  btn=" & (name of b) & linefeed
                            end repeat
                        end try
                        try
                            repeat with t in (text fields of w)
                                set out to out & "  field=" & (description of t) & linefeed
                            end repeat
                        end try
                        try
                            repeat with s in (sheets of w)
                                set out to out & "  * sheet title=" & (name of s) & linefeed
                                try
                                    repeat with b in (buttons of s)
                                        set out to out & "    btn=" & (name of b) & linefeed
                                    end repeat
                                end try
                                try
                                    repeat with t in (text fields of s)
                                        set out to out & "    field=" & (description of t) & linefeed
                                    end repeat
                                end try
                                try
                                    repeat with t in (static texts of s)
                                        set out to out & "    text=" & (value of t) & linefeed
                                    end repeat
                                end try
                            end repeat
                        end try
                    end repeat
                end tell
            end if
        end tell
        return out
    end if
    return "unknown-op:" & op
end run
APPLESCRIPT
    [[ -f $AS_FILE ]] || die "AppleScript 临时文件创建失败"
}

as_cleanup() { [[ -n $AS_TMPDIR && -d $AS_TMPDIR ]] && rm -rf "$AS_TMPDIR"; }

# ax <op> [args...]  →  stdout 为 AppleScript 返回值
ax() { osascript "$AS_FILE" "$@"; }

# ---------------------------------------------------------------- 配置 / 状态

CONF_ALIASES=(); CONF_IDS=(); CONF_REGIONS=()

default_conf() {
    cat <<'EOF'
# App Store 账号配置 —— appstore-switch.sh 读取
#
# 每行一个账号，空白分隔，三列：
#   alias    命令行里用的短名（switch <alias>）
#   apple_id 该账号的 Apple ID 邮箱
#   region   商店地区码，仅用于显示（切换后 storefront 自动跟随账号）
#
# 密码不放这里。给某个账号设密码：
#   appstore-switch.sh set-password <alias>
# 密码存进钥匙串，service = appstore-<alias>。

# alias   apple_id              region
cn        your-id@example.com   CN
ca        your-id@example.com   CA
EOF
}

load_conf() {
    [[ -f $CONF ]] || return 0
    local line alias id region
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%%#*}
        # 去掉首尾空白
        line=${line#"${line%%[![:space:]]*}"}
        line=${line%"${line##*[![:space:]]}"}
        [[ -z $line ]] && continue
        # shellcheck disable=SC2086
        set -- $line
        alias=${1:-}; id=${2:-}; region=${3:-}
        [[ -z $alias ]] && continue
        CONF_ALIASES+=("$alias"); CONF_IDS+=("$id"); CONF_REGIONS+=("$region")
    done <"$CONF"
}

conf_index() {
    local want=$1 i
    for ((i = 0; i < ${#CONF_ALIASES[@]}; i++)); do
        [[ ${CONF_ALIASES[i]} == "$want" ]] && { printf '%s' "$i"; return 0; }
    done
    return 1
}

state_read() {  # → alias \t display \t iso8601
    [[ -f $STATE ]] || return 1
    head -1 "$STATE" 2>/dev/null
}

state_write() {  # alias display
    mkdir -p "$CONF_DIR"
    printf '%s\t%s\t%s\n' "$1" "$2" "$(date '+%Y-%m-%dT%H:%M:%S%z')" >"$STATE"
}

state_alias() { state_read 2>/dev/null | cut -f1; }
state_display() { state_read 2>/dev/null | cut -f2; }

state_age_human() {
    local iso
    iso=$(state_read 2>/dev/null | cut -f3)
    [[ -z $iso ]] && return 1
    local then_s now_s
    then_s=$(date -j -f '%Y-%m-%dT%H:%M:%S%z' "$iso" '+%s' 2>/dev/null) || return 1
    now_s=$(date '+%s')
    local d=$((now_s - then_s))
    ((d < 60)) && { printf '刚刚'; return 0; }
    ((d < 3600)) && { printf '%d 分钟前' $((d / 60)); return 0; }
    ((d < 86400)) && { printf '%d 小时前' $((d / 3600)); return 0; }
    printf '%d 天前' $((d / 86400))
}

# ---------------------------------------------------------------- 等待 / 探测

# wait_for <描述> <判定命令...>：反复执行判定，直到返回 0 或超时
wait_for() {
    local desc=$1; shift
    local waited=0 interval=1
    while ((waited < TIMEOUT)); do
        if "$@"; then
            ((waited > 0)) && printf '\n'
            return 0
        fi
        ((waited % 5 == 0)) && printf '%s' "${YELLOW}.${NC}"
        sleep $interval
        waited=$((waited + interval))
    done
    ((waited > 0)) && printf '\n'
    warn "等待「${desc}」超时（${TIMEOUT}s）"
    return 1
}

ensure_appstore() {
    if ! pgrep -xq "App Store"; then
        step "启动 App Store"
        open -a "App Store"
    fi
    ax activate >/dev/null 2>&1
    wait_for "App Store 窗口出现" has_window || return 1
}

has_window() { [[ $(ax state 2>/dev/null | cut -f1) != "noapp" && $(ax state 2>/dev/null | cut -f1) != "nowin" ]]; }
is_signed_in() { [[ $(ax state 2>/dev/null | cut -f1) == "signed_in" ]]; }
is_signed_out() { [[ $(ax state 2>/dev/null | cut -f1) == "signed_out" ]]; }

current_display() { ax state 2>/dev/null | cut -f2; }

keychain_get() {  # alias → password on stdout
    security find-generic-password -w -s "$KEYCHAIN_PREFIX-$1" 2>/dev/null
}

keychain_has() {
    security find-generic-password -s "$KEYCHAIN_PREFIX-$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------- 命令实现

cmd_status() {
    load_conf
    local st sa sd age
    st=$(ax state 2>/dev/null)
    case ${st%%$'\t'*} in
        noapp)  info "App Store 未运行（这不代表未登录）" ;;
        nowin)  info "App Store 在运行但没有窗口" ;;
        nomenu) info "App Store 有窗口，但找不到「商店」菜单（版本差异？）" ;;
        signed_in)  ok "已登录，账号显示名：${st#*$'\t'}" ;;
        signed_out) info "未登录（侧栏按钮：${st#*$'\t'}）" ;;
        *)      info "状态未知：$st" ;;
    esac
    if sa=$(state_alias) && [[ -n $sa ]]; then
        sd=$(state_display); age=$(state_age_human)
        info "state 记录：${sa}（显示名 ${sd:-?}，${age}）"
    else
        info "state 记录：无（手动切换过账号时这就是过期的原因）"
    fi
    return 0
}

cmd_list() {
    load_conf
    if [[ ! -f $CONF ]]; then
        mkdir -p "$CONF_DIR"
        default_conf >"$CONF"
        ok "已生成配置模板：$CONF"
        info "填好 apple_id 后重新运行；密码用 set-password 写入钥匙串。"
        return 0
    fi
    if ((${#CONF_ALIASES[@]} == 0)); then
        warn "配置里没有有效账号行：$CONF"
        return 1
    fi
    local sa i mark pw
    sa=$(state_alias)
    info "配置：$CONF"
    for ((i = 0; i < ${#CONF_ALIASES[@]}; i++)); do
        mark=' '; [[ ${CONF_ALIASES[i]} == "$sa" ]] && mark='*'
        if keychain_has "${CONF_ALIASES[i]}"; then pw='钥匙串✓'; else pw='钥匙串✗'; fi
        printf '%s %-6s %-28s %-4s %s\n' "$mark" "${CONF_ALIASES[i]}" "${CONF_IDS[i]}" "${CONF_REGIONS[i]}" "$pw"
    done
    return 0
}

cmd_set_password() {
    local alias=${1:-}
    [[ -z $alias ]] && die "用法: appstore-switch.sh set-password <alias>"
    load_conf
    local idx id region
    if idx=$(conf_index "$alias"); then
        id=${CONF_IDS[idx]}; region=${CONF_REGIONS[idx]}
    else
        [[ -f $CONF ]] && warn "配置里没有 alias「${alias}」，仍然可以设置（之后记得补配置）"
        id=''; region=''
    fi
    local pw pw2
    printf '为 %s%s 设置 App Store 密码（不会回显）：' "$alias" "${region:+（${region}）}"
    IFS= read -rs pw; printf '\n'
    printf '再输一次确认：'
    IFS= read -rs pw2; printf '\n'
    [[ -z $pw ]] && die "密码为空，已取消"
    [[ $pw != "$pw2" ]] && die "两次输入不一致，已取消"
    # 用 security -i 走 stdin：密码不进 argv（ps 看不到）、不进 history
    local acct=${id:-$alias}
    if printf 'add-generic-password -U -s %s -a %s -w %s\n' \
        "$(secquote "$KEYCHAIN_PREFIX-$alias")" "$(secquote "$acct")" "$(secquote "$pw")" |
        security -i >/dev/null 2>"$AS_TMPDIR/sec.err"; then
        ok "已写入钥匙串（service=${KEYCHAIN_PREFIX}-$alias, account=${acct}）"
        if [[ -n $(keychain_get "$alias") ]]; then ok "回读自检通过"; else warn "回读失败，请检查钥匙串"; fi
    else
        warn "写入失败：$(cat "$AS_TMPDIR/sec.err" 2>/dev/null)"
        return 1
    fi
    unset pw pw2
    return 0
}

# security -i 的解析器是 shell 风格但不认 shell 的 '\'' 写法（实测会被截断），
# 所以统一用双引号包裹 + 转义 \ " $ ` —— 实测带 $ ' " 空格的密码能原样往返。
secquote() {
    local esc
    esc=$(printf '%s' "$1" | sed -e 's/[\\"$`]/\\&/g')
    printf '"%s"' "$esc"
}

cmd_dump_ax() {
    info "=== 窗口/进程 ==="; ax dump
    info "=== 面板 UI 树（sheet 优先） ==="; ax tree
    info "=== 面板里的文本栏 ==="; ax fields
    info "=== 面板里的文案 ==="; ax texts
}

# ---- 切换流程 -------------------------------------------------------------
#
# 全流程来自实测（macOS 26.x），不是猜的：
#   1. 商店菜单 → 退出登录：**没有**确认弹窗，点完立刻退出，侧栏显示名变成「登录」。
#   2. 商店菜单 → 登录：弹出 sheet，第一步只有 Apple ID 输入框（预填上次用的 ID）
#      和「登录」按钮；点「登录」后同一个 sheet 里出现安全文本栏（密码）。
#   3. 填密码再点「登录」→ 弹出另一个 sheet：双重认证 6 格验证码。
#   4. 验证码通过后可能再弹「Welcome to the App Store / 欢迎使用」引导页，
#      点 Continue 才算真正登录完成 —— 不点的话菜单里没有「退出登录」，
#      也就是看起来「没登上」。
#   5. 登录后 storefront 语言跟着账号变（CA 账号 → 菜单变成 Store / Sign Out），
#      所以菜单项、按钮名全部按「中/英候选名」匹配。
#
# 输入一律用 AX 的 set value，不用合成键盘事件：后者要「辅助功能」权限，
# 前者只要「自动化（控制 System Events）」权限 —— 实测 set value 对
# 安全文本栏同样有效。

DESC_TEXT='文本栏|text field'
DESC_SECURE='安全文本栏|secure text field'

# 只认登录面板（sheet）里的文本栏：窗口里的搜索框描述也是「文本栏」
# （搜索文本栏），不按作用域过滤就会把 Apple ID 填进搜索框（实测踩过）。
field_lines() { ax fields 2>/dev/null | awk -F'|' '$2 ~ /^sheet/'; }

# fields 每行格式：procName|scope/path|role|desc|value —— 描述在第 4 列
field_ready() { field_lines | awk -F'|' -v m="$1" '$4 ~ m {f=1} END{exit !f}'; }

# fields 输出里第几个（1-based）文本栏的描述匹配 m
field_index() { field_lines | awk -F'|' -v m="$1" '$4 ~ m {print NR; exit}'; }

panel_texts() { ax texts 2>/dev/null; }

# 显示名里可能带余额（如 "Hongbo He, $7.93"），比对前去掉，避免余额变动导致误判
norm_display() { printf '%s' "$1" | sed -E 's/,[[:space:]]*[$€£¥][0-9.,]+$//'; }

# fill_field <n> <value> [verify=1]
# 写完回读一次：并不是所有字段都吃 AX set value（验证码框会被清空），
# 能校验的就必须校验，免得「以为填上了其实没有」。
# 安全文本栏读回是掩码，所以密码那步传 0 跳过校验。
fill_field() {
    local n=$1 v=$2 verify=${3:-1} cur
    [[ $(ax setfield "$n" "$v" 2>&1) == ok ]] || return 1
    ((verify)) || return 0
    sleep 1
    cur=$(field_lines | awk -F'|' -v n="$n" 'NR == n {print $5}')
    [[ $cur == "$v" ]]
}

do_sign_out() {
    step "退出当前账号"
    local clicked
    clicked=$(ax clickmenu "退出登录" "Sign Out")
    [[ -z $clicked ]] && { warn "商店菜单里没有「退出登录」项（可能本来就未登录）"; return 0; }
    # 实测没有确认弹窗；仍然兜底点一次候选按钮，跨系统版本时可能用得上
    sleep 1
    if ! is_signed_out; then
        local r
        r=$(ax clickbutton "退出登录" "退出" "Sign Out" "确定" "OK")
        [[ -n $r ]] && info "  确认弹窗：点击「${r}」"
    fi
    wait_for "退出登录完成" is_signed_out || {
        warn "还没退出，当前 AX 结构："
        ax tree
        return 1
    }
    ok "已退出登录"
    # 刚退出时商店页面还在重载，此刻点「登录」菜单项经常被吞掉（实测），
    # 稍等一下再进登录流程
    sleep 2
    return 0
}

# 点菜单项打开登录面板；App Store 偶发吞掉这次点击，所以重试 + 短等待
open_login_panel() {
    local attempt entered
    for attempt in 1 2 3; do
        ((attempt > 1)) && { info "  重试打开登录面板（第 ${attempt} 次）"; sleep 2; }
        ax activate >/dev/null 2>&1
        sleep 1
        entered=$(ax clickmenu "登录" "Sign In")
        [[ -z $entered ]] && entered=$(ax clickbutton "登录" "Sign In")
        [[ -z $entered ]] && continue
        TIMEOUT=12 wait_for "Apple ID 输入框" field_ready "$DESC_TEXT" && return 0
    done
    warn "点不开登录面板（商店菜单里没有「登录 / Sign In」或点击被忽略）"
    return 1
}

do_sign_in() {
    local alias=$1 apple_id=$2
    step "打开登录面板"
    if field_ready "$DESC_TEXT"; then
        info "  登录面板已经开着，直接复用"
    else
        open_login_panel || { ax tree; return 1; }
    fi
    sleep 1
    local n
    n=$(field_index "$DESC_TEXT")
    [[ -z $n ]] && { warn "找不到 Apple ID 输入框"; ax tree; return 1; }
    fill_field "$n" "$apple_id" || { warn "填写 Apple ID 失败"; return 1; }
    ok "已填入 ${apple_id}"

    if [[ ${MANUAL_ID:-0} == 1 ]]; then
        warn "按 --manual-id 停在这里：剩下的请手动完成"
        return 2
    fi

    step "提交 Apple ID"
    ax clickbutton "登录" "Sign In" "继续" "Continue" >/dev/null

    wait_for "密码输入框" field_ready "$DESC_SECURE" || { ax tree; return 1; }

    if [[ ${MANUAL_PASSWORD:-0} == 1 ]]; then
        warn "请在面板里手动输入密码并登录（我继续等你完成）"
        handle_post_password "$alias"
        return $?
    fi

    local pw
    pw=$(keychain_get "$alias")
    if [[ -z $pw ]]; then
        warn "钥匙串里没有 ${KEYCHAIN_PREFIX}-${alias} 的密码，请手动输入"
        warn "（或用 appstore-switch.sh set-password ${alias} 写入后重试）"
        handle_post_password "$alias"
        return $?
    fi
    n=$(field_index "$DESC_SECURE")
    [[ -z $n ]] && { warn "找不到密码输入框"; ax tree; unset pw; return 1; }
    if fill_field "$n" "$pw" 0; then
        ok "已填入密码（来自钥匙串）"
    else
        warn "写入密码框失败"; unset pw; return 1
    fi
    unset pw

    step "提交密码"
    ax clickbutton "登录" "Sign In" >/dev/null
    sleep 2
    handle_post_password "$alias"
}

# 提交密码之后可能依次出现：双重认证 → 欢迎页 → 真正登录成功。
# 用面板里的文案判断当前卡在哪一步。
#
# 双重认证的验证码框是 6 格分段输入，实测 AX 的 set value 写进去会被立刻清空，
# 只有真实键盘事件才能触发提交；而合成键盘事件需要给「运行脚本的终端」授
# 「辅助功能」权限。本项目刻意不要求这个权限，所以验证码由你在面板里手输。
handle_post_password() {
    local alias=$1
    local waited=0 announced=0 texts limit
    limit=$((TIMEOUT * 3))
    while ((waited < limit)); do
        if is_signed_in; then
            return 0
        fi
        texts=$(panel_texts)
        if grep -Eqi '验证码|verification code|双重认证|two-factor' <<<"$texts"; then
            if ((announced == 0)); then
                announced=1
                warn "需要双重认证：请在弹出的面板里输入 6 位验证码（我在这里等）"
                warn "  没收到就点面板里的「没有收到验证码？」重发"
            fi
            limit=$((TIMEOUT * 5))   # 人工输入，给 5 倍等待
            sleep 2; waited=$((waited + 2)); continue
        fi
        if grep -Eqi 'welcome to the app store|欢迎使用|欢迎来到' <<<"$texts"; then
            step "关闭 App Store 欢迎页"
            ax clickbutton "Continue" "继续" "Agree" "同意" "OK" "好" >/dev/null
            sleep 2; continue
        fi
        if grep -Eqi 'incorrect|不正确|密码错误|无法登录|could not|cannot verify' <<<"$texts"; then
            warn "登录失败：$(printf '%s' "$texts" | tr '\n' ' ' | cut -c1-200)"
            return 1
        fi
        sleep 2; waited=$((waited + 2))
    done
    warn "等待登录完成超时"
    ax tree
    return 1
}

cmd_switch() {
    local alias=''
    while (($#)); do
        case $1 in
            -y|--yes) YES=1 ;;
            -n|--dry-run) DRY=1 ;;
            --force) FORCE=1 ;;
            --manual-password) MANUAL_PASSWORD=1 ;;
            --manual-id) MANUAL_ID=1 ;;
            --timeout) shift; TIMEOUT=${1:-60} ;;
            -*) die "未知选项：$1" ;;
            *) alias=$1 ;;
        esac
        shift
    done

    load_conf
    [[ -z $alias ]] && die "用法: appstore-switch.sh switch <alias>（先跑 list 看有哪些）"
    if [[ ! -f $CONF ]]; then
        cmd_list
        die "配置还没填好：$CONF"
    fi
    local idx
    idx=$(conf_index "$alias") || die "配置里没有 alias「${alias}」（可用：${CONF_ALIASES[*]}）"
    local apple_id=${CONF_IDS[idx]} region=${CONF_REGIONS[idx]}
    [[ -z $apple_id ]] && die "配置里「${alias}」的 apple_id 是空的"

    if [[ ${MANUAL_PASSWORD:-0} == 0 ]] && ! keychain_has "$alias"; then
        warn "钥匙串里没有 ${KEYCHAIN_PREFIX}-$alias 的密码（可先跑：appstore-switch.sh set-password ${alias}）"
        MANUAL_PASSWORD=1
    fi

    # 已是目标账号？state 记录的 alias + 显示名双确认（显示名比对前去掉余额）
    local sa sd cd
    sa=$(state_alias); sd=$(norm_display "$(state_display)"); cd=$(norm_display "$(current_display)")
    if [[ ${FORCE:-0} == 0 && $sa == "$alias" && ( -z $sd || -z $cd || $sd == "$cd" ) ]]; then
        ok "已经是 ${alias}（${region}），无需切换。（--force 可强制重切）"
        return 0
    fi

    info "目标账号：${alias}  ${apple_id}  ${region}"
    [[ -n $cd ]] && info "当前显示名：${cd}"
    if [[ ${DRY:-0} == 1 ]]; then
        info "[dry-run] 将要：确保 App Store 运行 → 已登录则退出登录 → 登录 $apple_id → (必要时) 填验证码 → 写 state"
        return 0
    fi
    if [[ ${YES:-0} == 0 ]]; then
        printf '现在开始切换？（App Store 会被登出）[y/N] '
        local a; IFS= read -r a
        [[ $a == y || $a == Y ]] || { info "已取消"; return 1; }
    fi

    ensure_appstore || return 1

    if is_signed_in; then
        do_sign_out || return 1
    else
        info "当前未登录，跳过登出"
    fi

    local rc=0
    do_sign_in "$alias" "$apple_id" || rc=$?
    if ((rc == 2)); then
        warn "已按 --manual-id 停在登录面板：请手动完成登录，之后用 status 查看状态"
        return 0
    fi
    if ((rc != 0)); then
        warn "切换在「登录」阶段中断（rc=${rc}），不再等待"
        return 1
    fi

    if wait_for "登录完成" is_signed_in; then
        state_write "$alias" "$(current_display)"
        ok "已切换到 ${alias}（${region}），显示名：$(current_display)"
        return 0
    fi
    warn "切换未完成（rc=${rc}）。建议："
    warn "  1) 看上面的 AX 结构判断卡在哪一步；"
    warn "  2) 也可直接在 App Store 里手动登录，然后用 status 校正 state。"
    return 1
}

# ---------------------------------------------------------------- 主流程

main() {
    local cmd=${1:-help}
    [[ $# -gt 0 ]] && shift
    case $cmd in
        help|-h|--help) usage; return 0 ;;
        status) as_init; trap as_cleanup EXIT; cmd_status ;;
        list) cmd_list ;;
        set-password) as_init; trap as_cleanup EXIT; cmd_set_password "$@" ;;
        dump-ax) as_init; trap as_cleanup EXIT; cmd_dump_ax ;;
        switch) as_init; trap as_cleanup EXIT; cmd_switch "$@" ;;
        *) usage; return 2 ;;
    esac
}

main "$@"
