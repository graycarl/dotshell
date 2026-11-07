#!/bin/bash
#
# magic-cli — 用自然语言生成 shell 命令，确认后在当前 shell 执行
#
#   $ magic-cli 把当前目录的 png 图片 size 缩小一半
#     -|/ thinking...
#   CMD: for f in *.png; do ... ; done
#   执行? [Y/n/e] (或直接输入修改意见):
#
# 实现要点：
#   - 需求 + 少量环境上下文（cwd / 工具清单 / git / 最近命令 / 目录内容）交给
#     `pi -p` 非交互模式，禁用全部工具，只让它返回命令文本
#   - 确认后用 eval 在当前 shell 执行，所以 cd / export 会留在当前 shell
#   - 生成的命令写入 shell 历史，执行完还能用 ↑ 召回修改
#
# 环境变量：
#   MAGIC_MODEL     模型，默认 deepseek/deepseek-flash
#   MAGIC_THINKING  思考等级（off/minimal/low/medium/high/xhigh/max），默认沿用
#                   ~/.pi/agent/settings.json 的 defaultThinkingLevel
#   MAGIC_USES      =0 时不让模型自报用到的命令，也不做「命令不存在」自动重写
#                   （语法预检仍然生效）
#   MAGIC_CTX       =off 时不把最近的 shell 历史发给模型。默认是发的——历史里若有
#                   token/密码，会被一起送到模型服务端
#   MAGIC_DEBUG     =1 时在 stderr 打印实际发给模型的 prompt
#
# 退出码：执行成功为 0，执行失败为命令自身的退出码；用户取消为 1；Ctrl-C 为 130；
#         找不到 pi 为 127。
#
# 注意：危险规则是启发式黑名单，只用来提示，不是安全边界。
# 不要在加载期做任何探测/子进程调用（见 AGENTS.md），所有工作都发生在函数调用时。

function magic-cli() {
    if [[ $# -eq 1 ]]; then
        case $1 in
            -h|--help|help)
                _magic-cli-usage
                return 0
                ;;
        esac
    fi

    if ! command -v pi >/dev/null 2>&1; then
        printf '\033[31mmagic-cli: 找不到 pi 命令（依赖 pi coding agent）\033[0m\n' >&2
        return 127
    fi

    local query
    if [[ $# -gt 0 ]]; then
        query=$*
    elif [[ -t 0 ]]; then
        printf '\033[36m请输入需求:\033[0m ' >&2
        IFS= read -r query || return 1
    else
        query=$(cat)
    fi
    if [[ -z $query || -z ${query//[[:space:]]/} ]]; then
        printf '\033[31mmagic-cli: 需求为空\033[0m\n' >&2
        return 1
    fi
    if [[ ! -t 0 ]] && ! _magic-cli-has-tty; then
        printf '\033[31mmagic-cli: 需要终端来确认执行\033[0m\n' >&2
        return 1
    fi

    local tmpout tmperr
    tmpout=$(_magic-cli-mktemp) || return 1
    tmperr=$(_magic-cli-mktemp) || { rm -f "$tmpout"; return 1; }

    # Ctrl-C 只做清理并置位标记，由主流程的统一出口决定退出码。
    # 这些变量故意留在本函数的 local 作用域里（cleanup/spinner 通过动态作用域读取），
    # 函数返回后不会污染用户的 shell。
    local _MAGIC_CLI_INTERRUPTED='' _MAGIC_CLI_REPLY='' _MAGIC_CLI_SPIN_PID=''
    # 保存调用方原有的 INT/TERM trap，退出时恢复（zsh 的 trap 不支持 -p，跳过）
    local _MAGIC_CLI_SAVED_INT='' _MAGIC_CLI_SAVED_TERM=''
    if [[ -z ${ZSH_VERSION-} ]]; then
        _MAGIC_CLI_SAVED_INT=$(trap -p INT 2>/dev/null)
        _MAGIC_CLI_SAVED_TERM=$(trap -p TERM 2>/dev/null)
    fi
    trap '_MAGIC_CLI_INTERRUPTED=1; _magic-cli-cleanup "$tmpout" "$tmperr"' INT TERM

    local cmd='' prev='' feedback='' danger='' syntax=''
    local missing='' missing_list='' warn_only='' named='' reason='' w=''
    local fix_left=1 grc=0
    while :; do
        # ---- 生成 ----
        _magic-cli-generate "$query" "$prev" "$feedback" "$tmpout" "$tmperr"
        grc=$?
        if [[ $grc -ne 0 ]]; then
            # 先打印 pi 的 stderr（模型/鉴权/网络错误的原因都在这里），再删临时文件
            if [[ $grc -ne 130 && -z $_MAGIC_CLI_INTERRUPTED ]]; then
                printf '\033[31mmagic-cli: 调用 pi 失败（exit %d）\033[0m\n' "$grc" >&2
                [[ -s $tmperr ]] && sed -n '1,20p' "$tmperr" >&2
            fi
            _magic-cli-cleanup "$tmpout" "$tmperr"
            if [[ $grc -eq 130 || -n $_MAGIC_CLI_INTERRUPTED ]]; then
                return 130
            fi
            return 1
        fi
        if grep -q '^#ERROR' "$tmpout" 2>/dev/null; then
            printf '\033[33m%s\033[0m\n' "$(grep -m1 '^#ERROR' "$tmpout" | sed 's/^#ERROR[[:space:]]*//')" >&2
            _magic-cli-cleanup "$tmpout" "$tmperr"
            return 1
        fi
        cmd=$(_magic-cli-clean <"$tmpout")
        if [[ -z $cmd ]]; then
            printf '\033[31mmagic-cli: 模型没有返回任何命令\033[0m\n' >&2
            _magic-cli-cleanup "$tmpout" "$tmperr"
            return 1
        fi
        prev=$cmd

        # ---- 预检：语法 + 模型自报的命令是否都存在（最多自动重写 1 次）----
        syntax=$(_magic-cli-syntax-error "$cmd")
        if [[ ${MAGIC_USES-} != 0 ]]; then
            # #USES 是模型自报的「意图清单」，不可信，只当一个软信号：
            # 名字不在命令文本里就当它只是备选方案，只提示不重写。
            missing=$(_magic-cli-missing-cmds "$cmd" "$(_magic-cli-uses "$tmpout")")
            warn_only=$(printf '%s\n' "$missing" | sed -n 's/^?//p' | tr '\n' ' ')
            missing=$(printf '%s\n' "$missing" | sed -e '/^?/d' -e '/^$/d')
            # 需求里点名的命令不自动替换（用户可能就是想装它）
            named=''
            while IFS= read -r w; do
                [[ -z $w ]] && continue
                if [[ $query == *"$w"* ]]; then
                    named="$named $w"
                else
                    missing_list="$missing_list $w"
                fi
            done <<<"$missing"
            missing=${missing_list# }
            missing_list=''
            warn_only=${warn_only% }
            if [[ -n $named ]]; then
                printf '\033[33mmagic-cli: 需求里指定的命令本机未安装:%s（不自动替换，可先安装）\033[0m\n' "$named" >&2
            fi
            if [[ -n $warn_only ]]; then
                printf '\033[33mmagic-cli: 模型提到但未安装的命令（命令里没出现，忽略）: %s\033[0m\n' "$warn_only" >&2
            fi
        fi
        if [[ -n $syntax || -n $missing ]]; then
            reason=''
            if [[ -n $syntax ]]; then
                reason='语法检查失败'
            fi
            if [[ -n $missing ]]; then
                if [[ -n $reason ]]; then
                    reason="$reason；缺少命令: $missing"
                else
                    reason="缺少命令: $missing"
                fi
            fi
            if ((fix_left > 0)); then
                fix_left=$((fix_left - 1))
                feedback="上一版命令有问题，请修正后重新输出（仍然先输出 #USES 行）：
${syntax:+语法错误：
$syntax
}${missing:+本机不存在这些命令：$missing
请改用已安装的工具（见环境信息）或纯系统自带命令，不要再用它们。
}"
                printf '\033[33mmagic-cli: %s，自动重写一次…\033[0m\n' "$reason" >&2
                continue
            fi
            printf '\033[33mmagic-cli: %s（已用完自动修复次数，按原样展示）\033[0m\n' "$reason" >&2
        fi

        # ---- 确认 / 编辑 / 反馈 ----
        while :; do
            _magic-cli-show "$cmd"
            if ! _magic-cli-read '执行? [Y/n/e] (或直接输入修改意见): '; then
                _magic-cli-cleanup "$tmpout" "$tmperr"
                [[ -n ${_MAGIC_CLI_INTERRUPTED-} ]] && return 130
                return 1
            fi
            case $_MAGIC_CLI_REPLY in
                ''|y|Y|yes|YES|Yes)
                    if danger=$(_magic-cli-danger-check "$cmd"); then
                        printf '\033[1;33m⚠  这条命令命中危险操作规则：%s\033[0m\n' "$danger" >&2
                        if ! _magic-cli-read '确实要执行请手动输入 yes: '; then
                            _magic-cli-cleanup "$tmpout" "$tmperr"
                            [[ -n ${_MAGIC_CLI_INTERRUPTED-} ]] && return 130
                            return 1
                        fi
                        if [[ $_MAGIC_CLI_REPLY != yes ]]; then
                            printf '\033[90m已取消\033[0m\n' >&2
                            _magic-cli-cleanup "$tmpout" "$tmperr"
                            return 1
                        fi
                    fi
                    break 2
                    ;;
                n|N|no|NO|No|q|Q)
                    printf '\033[90m已取消\033[0m\n' >&2
                    _magic-cli-cleanup "$tmpout" "$tmperr"
                    return 1
                    ;;
                e|E)
                    if cmd=$(_magic-cli-edit "$cmd"); then
                        prev=$cmd
                    else
                        cmd=$prev
                    fi
                    ;;
                *)
                    feedback=$_MAGIC_CLI_REPLY
                    break
                    ;;
            esac
        done
    done

    # ---- 执行 ----
    _magic-cli-cleanup "$tmpout" "$tmperr"

    _magic-cli-history "$cmd"
    printf '\033[90m$\033[0m %s\n' "$cmd" >&2
    eval "$cmd"
    local rc=$?
    if [[ $rc -ne 0 ]]; then
        printf '\033[31m[exit %d]\033[0m\n' "$rc" >&2
    fi
    return $rc
}

# ---------------------------------------------------------------- 内部辅助函数

function _magic-cli-usage() {
    cat <<'EOF'
magic-cli — 用自然语言生成 shell 命令，确认后执行

用法：
    magic-cli <需求描述>        例：magic-cli 把当前目录的 png 图片 size 缩小一半
    magic-cli                   交互式输入需求
    echo <需求> | magic-cli     从 stdin 读需求（管道内容是「需求」，不是给生成命令的输入）

确认时：
    回车 / y    执行（命令会写入历史，可用 ↑ 召回修改）
    n           放弃（退出码 1）
    e           用 $EDITOR 修改命令后再确认
    其他文字    当作修改意见重新生成

生成过程中随时可以 Ctrl-C 中断（退出码 130）。

环境变量：
    MAGIC_MODEL     模型，默认 deepseek/deepseek-flash
    MAGIC_THINKING  思考等级（off/minimal/low/medium/high/xhigh/max），
                    默认沿用 pi 配置里的 defaultThinkingLevel
    MAGIC_USES      =0 时不做「命令不存在」预检和自动重写（语法预检仍生效）
    MAGIC_CTX       =off 时不把最近的 shell 历史发给模型（默认会发）
    MAGIC_DEBUG     =1 时打印实际发给模型的 prompt

注意：危险命令规则是启发式黑名单，只用于提示，不构成安全边界。
EOF
}

function _magic-cli-mktemp() {
    mktemp "${TMPDIR:-/tmp}/magic-cli.XXXXXX"
}

function _magic-cli-cleanup() {
    # 通过动态作用域读取调用方 magic-cli 里的 local 变量
    _magic-cli-spin-stop
    rm -f "${1-}" "${2-}"
    trap - INT TERM
    [[ -n ${_MAGIC_CLI_SAVED_INT-} ]] && eval "$_MAGIC_CLI_SAVED_INT"
    [[ -n ${_MAGIC_CLI_SAVED_TERM-} ]] && eval "$_MAGIC_CLI_SAVED_TERM"
    return 0
}

function _magic-cli-generate() {
    # $1=需求 $2=上一版命令 $3=反馈 $4=stdout 文件 $5=stderr 文件
    local query=$1 prev=$2 feedback=$3 out=$4 err=$5
    local prompt='' rc=0
    prompt=$(_magic-cli-prompt "$query" "$prev" "$feedback")
    if [[ ${MAGIC_DEBUG-} == 1 ]]; then
        printf '\033[90m--- magic-cli prompt ---\n%s\n------------------------\033[0m\n' "$prompt" >&2
    fi
    # 参数用 set -- 累积而不是数组：bash 3.2 在 set -u 下展开空数组会报 unbound variable
    set -- -p -nt -ne -ns -np -nc --no-mcp --no-session \
        --model "${MAGIC_MODEL:-deepseek/deepseek-flash}"
    [[ -n ${MAGIC_THINKING-} ]] && set -- "$@" --thinking "${MAGIC_THINKING}"
    set -- "$@" -- "$prompt"
    _magic-cli-spin-start
    # </dev/null：否则 pi 会把继承来的 stdin 内容拼进 prompt（-p 模式的文档行为）
    pi "$@" >"$out" 2>"$err" </dev/null
    rc=$?
    _magic-cli-spin-stop
    return $rc
}

function _magic-cli-prompt() {
    local query=$1 prev=$2 feedback=$3
    local shell_name=bash
    [[ -n ${ZSH_VERSION-} ]] && shell_name=zsh
    printf '%s\n' \
        '你是 shell 命令生成器：把用户需求转换成本机 shell 中可以直接执行的命令。' \
        '' \
        '规则：' \
        '1. 不要解释、不要 markdown 代码围栏、不要在行首加 "$ "。' \
        '2. 需要多步时输出多行脚本，保证一次性可执行，不要留占位符。' \
        "3. 当前 shell 是 ${shell_name}（$(uname -s)）。优先使用系统自带命令（macOS 自带 sips、plutil、pbcopy、mdfind 等）。" \
        '4. 如果需求无法用 shell 命令完成，只输出一行：#ERROR <简短原因>'
    if [[ ${MAGIC_USES-} != 0 ]]; then
        printf '%s\n' \
            '' \
            '输出格式：' \
            '第一行：#USES: <本命令会执行到的所有外部命令，空格分隔>' \
            '第二行起：命令本身' \
            '只列真正会被执行的外部命令；shell 关键字和内建（for、do、cd、echo 等）不必列。' \
            '拿不准本机是否装了某个工具时，优先换成系统自带命令，而不是赌它存在。'
    fi
    printf '%s\n' \
        '' \
        '环境信息：' \
        "$(_magic-cli-context)" \
        '' \
        "用户需求：$query"
    if [[ -n $prev ]]; then
        printf '\n%s\n' '---' '上一版生成的命令：' "$prev" \
            "用户反馈：$feedback" '请按反馈修正，仍然只输出命令本身。'
    fi
}

function _magic-cli-uses() {
    # 从 pi 输出里取模型自报的 #USES 列表（容忍全角冒号/全角逗号/大小写）
    local line=''
    line=$(grep -m1 -iE '^#[[:space:]]*uses' "$1" 2>/dev/null) || return 0
    printf '%s' "$line" |
        sed -e 's/：/:/g' -e 's/，/,/g' -e 's/^#[^:]*://' -e 's/^#[^:]*$//'
}

function _magic-cli-syntax-error() {
    # 用当前 shell 做语法检查；有错则输出错误信息
    local sh=zsh
    [[ -z ${ZSH_VERSION-} ]] && sh=bash
    "$sh" -n 2>&1 <<<"$1"
}

function _magic-cli-missing-cmds() {
    # $1=命令文本 $2=自报的 #USES 列表
    # 输出：name  = 自报缺失且确实出现在命令文本里（高置信度，可自动重写）
    #       ?name = 只在自报里出现（可能只是备选方案，仅提示）
    local cmd=$1 uses=$2 w=''
    # 注意结尾要有换行，否则 read 读到没有换行的最后一段会返回非 0 而被循环跳过
    printf '%s\n' "$uses" | tr -s ' ,' '\n\n' | while IFS= read -r w; do
        [[ -z $w ]] && continue
        case $w in
            -*) continue ;;
            for|in|do|done|if|then|elif|else|fi|while|until|select|case|esac|function|\
            local|declare|typeset|export|readonly|unset|shift|return|exit|break|continue|\
            cd|echo|printf|read|test|true|false|exec|eval|source|trap|umask|type|\
            set|alias|command|builtin|time|wait|jobs|kill|pwd|let|'['|'[['|']]'|'{'|'}'|'!')
                continue
                ;;
        esac
        # 脚本自己定义的函数/别名不算缺失
        case $cmd in
            *"alias $w="*|*"function $w"*|*"$w()"*|*"$w ()"*) continue ;;
        esac
        command -v -- "$w" >/dev/null 2>&1 && continue
        case $cmd in
            *"$w"*) printf '%s\n' "$w" ;;
            *) printf '?%s\n' "$w" ;;
        esac
    done
}

function _magic-cli-context() {
    # 拼接顺序 = 重要度顺序，超长时 cut 掉的是末尾的目录清单
    local out='' files='' st='' recent='' t='' tools=''
    out="cwd: $PWD"
    # command -v 是内建命令，不会 fork
    for t in rg fd jq ffmpeg magick convert exiftool gh uv python3; do
        command -v -- "$t" >/dev/null 2>&1 && tools="$tools $t"
    done
    [[ -n $tools ]] && out="$out
已安装的常用工具:$tools"
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        out="$out
git: 分支 $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
        st=$(git status --short 2>/dev/null | head -n 20 | tr '\n' '|')
        [[ -n $st ]] && out="$out; 改动: $st"
    fi
    if [[ ${MAGIC_CTX-} != off ]]; then
        recent=$(_magic-cli-recent-history)
        [[ -n $recent ]] && out="$out
最近执行的命令（旧→新）:
$recent"
    fi
    files=$(ls -A 2>/dev/null | head -n 80 | tr '\n' ' ')
    [[ -n $files ]] && out="$out
目录内容: $files"
    printf '%s' "${out:0:4000}"
}

function _magic-cli-recent-history() {
    if [[ -n ${ZSH_VERSION-} ]]; then
        # 历史不足 8 条时 fc -ln -8 会报 no such event 并返回非 0，退化成全量
        { fc -ln -8 2>/dev/null || fc -ln 2>/dev/null; } |
            sed 's/^[[:space:]]*//' | grep -v 'magic-cli' | tail -n 5
    elif [[ $- == *i* ]]; then
        HISTTIMEFORMAT= history 8 2>/dev/null |
            sed 's/^[[:space:]]*[0-9]*[[:space:]]*//' | grep -v 'magic-cli' | tail -n 5
    fi
}

function _magic-cli-clean() {
    # 去掉代码围栏、#USES 行、行首 "$ "、行尾空白和首部空行。
    # 不能删其它 # 开头的行：生成的脚本可能含 heredoc/shebang，删了会静默改坏脚本。
    sed -e 's/\r$//' \
        -e '/^[[:space:]]*```/d' \
        -e '/^[[:space:]]*#[Uu][Ss][Ee][Ss]/d' \
        -e 's/^[[:space:]]*\$ //' \
        -e 's/[[:space:]]*$//' |
        sed -e '/./,$!d'
}

function _magic-cli-show() {
    local cmd=$1 line='' first=1
    while IFS= read -r line; do
        if [[ $first == 1 ]]; then
            printf '\033[1;36mCMD:\033[0m %s\n' "$line" >&2
            first=0
        else
            printf '     %s\n' "$line" >&2
        fi
    done <<<"$cmd"
}

function _magic-cli-has-tty() {
    # 真正尝试打开 /dev/tty：某些环境（无控制终端）里文件存在但打开会失败
    [[ -c /dev/tty ]] || return 1
    ( : </dev/tty 3>/dev/tty ) 2>/dev/null
}

function _magic-cli-read() {
    # 读一行到 $_MAGIC_CLI_REPLY；stdin 被占用时回落到 /dev/tty
    _MAGIC_CLI_REPLY=''
    if [[ -t 0 ]]; then
        printf '\033[1;33m%s\033[0m' "$1" >&2
        IFS= read -r _MAGIC_CLI_REPLY || return 1
    elif _magic-cli-has-tty; then
        printf '\033[1;33m%s\033[0m' "$1" >/dev/tty 2>/dev/null
        IFS= read -r _MAGIC_CLI_REPLY </dev/tty 2>/dev/null || return 1
    else
        printf '\033[31mmagic-cli: 没有终端可用于确认\033[0m\n' >&2
        return 1
    fi
    return 0
}

function _magic-cli-edit() {
    local cmd=$1 tmp='' edited='' rc=0
    local -a ed=()
    tmp=$(_magic-cli-mktemp) || return 1
    printf '%s\n' "$cmd" >"$tmp"
    # 允许 EDITOR 带参数，如 EDITOR="code -w"（zsh 需要 ${=} 才会做词分割）
    if [[ -n ${ZSH_VERSION-} ]]; then
        ed=(${=EDITOR:-vi})
    else
        ed=(${EDITOR:-vi})
    fi
    "${ed[@]}" "$tmp"
    rc=$?
    edited=$(_magic-cli-clean <"$tmp")
    rm -f "$tmp"
    if [[ $rc -ne 0 ]]; then
        printf '\033[33m%s 退出码 %d，保留原命令\033[0m\n' "${ed[0]}" "$rc" >&2
        return 1
    fi
    if [[ -z $edited ]]; then
        printf '\033[33m编辑后内容为空，保留原命令\033[0m\n' >&2
        return 1
    fi
    printf '%s' "$edited"
}

function _magic-cli-history() {
    # zsh 的 print -s 会把换行转义成字面 "\n"，↑ 召回后不可执行，所以多行先压成单行
    local line=$1
    if [[ $line == *$'\n'* ]]; then
        line=$(printf '%s\n' "$line" | tr '\n' ';' |
            sed -e 's/;;*/;/g' -e 's/do;/do /g' -e 's/then;/then /g' \
                -e 's/else;/else /g' -e 's/{;/ { /g' -e 's/;[[:space:]]*}/; }/g' \
                -e 's/[[:space:]]*$//')
    fi
    if [[ -n ${ZSH_VERSION-} ]]; then
        print -s -- "$line" 2>/dev/null
    elif [[ $- == *i* ]]; then
        history -s -- "$line" 2>/dev/null
    fi
}

function _magic-cli-danger-check() {
    # 启发式黑名单：命中则打印规则说明并返回 0，否则返回 1。
    # 用 grep -E 而非 =~ 让 bash/zsh 行为一致。条目格式：说明@@正则[@@排除正则]。
    # 分隔符不能用 |，否则正则里的交替会被切开。
    # 匹配前先去掉引号和 ${HOME} 的花括号，避免为引号组合写一堆正则。
    local cmd=$1 entry='' rest='' label='' rx='' neg='' norm=''
    local -a rules=(
        '删除根目录@@rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*[rf][a-zA-Z]*[[:space:]]+(--[[:space:]]+)?(/|/\*|\$HOME)/?([[:space:];&)]|$)'
        '删除家目录@@rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*[rf][a-zA-Z]*[[:space:]]+(--[[:space:]]+)?(~|~/|~/\*)([[:space:];&)]|$)'
        '删除变量指向的路径@@rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*-[a-zA-Z]*[rf][a-zA-Z]*[[:space:]]+\$[A-Za-z_][A-Za-z0-9_]*([[:space:];&)]|$)'
        '格式化文件系统@@mkfs'
        '直接写裸设备@@of=/dev/(disk|rdisk|sd[a-z]|nvme|hd)'
        '对根目录或家目录递归开放全部权限@@chmod[[:space:]]+-R[[:space:]]+777[[:space:]]+(/|~)([[:space:];&)]|$)'
        '把网络脚本直接喂给 shell@@(curl|wget)[^|;]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z)?sh'
        '用 shell -c 执行网络内容@@(ba|z)?sh[[:space:]]+-c[[:space:]][^|;]*(curl|wget)'
        'Fork bomb@@:\(\)[[:space:]]*\{[^}]*\}[[:space:]]*;[[:space:]]*:'
        '关机或重启@@(^|[[:space:]])(shutdown|reboot|halt)([[:space:]]|$)'
        '强制推送覆盖远端@@git[[:space:]]+push[^|;]*([[:space:]]-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|--force([^-]|$))'
        '丢弃未提交的改动@@git[[:space:]]+reset[[:space:]]+--hard'
        '删除未跟踪的文件@@git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fd]@@git[[:space:]]+clean[^|;]*-[a-zA-Z]*n'
        '用 sudo 强制删除@@sudo[[:space:]].*rm[[:space:]]+-[a-zA-Z]*[rf]'
    )
    norm=$(printf '%s' "$cmd" | tr -d "\"'" | sed -e 's/${HOME}/$HOME/g')
    for entry in "${rules[@]}"; do
        label=${entry%%@@*}
        rest=${entry#*@@}
        rx=${rest%%@@*}
        neg=''
        [[ $rest == *@@* ]] && neg=${rest#*@@}
        if printf '%s' "$norm" | grep -Eq -- "$rx"; then
            if [[ -n $neg ]] && printf '%s' "$norm" | grep -Eq -- "$neg"; then
                continue
            fi
            printf '%s' "$label"
            return 0
        fi
    done
    return 1
}

# ---------------------------------------------------------------- spinner
#
# spinner 必须放到后台跑（等 pi 返回期间要动），但交互式 shell 给后台任务启动/结束时
# 会打印 "[1] pid" / "terminated"，把提示弄乱。做法：在一个非交互子 shell 里启动它，
# 子 shell 的 stderr 指向 /dev/null 吞掉这些通知，spinner 自己把动画写到 /dev/tty。
# 它是孤儿进程（ppid 会变成 1），所以循环里自带「父 shell 还在吗」的检查。

function _magic-cli-spin-start() {
    _MAGIC_CLI_SPIN_PID=''
    _magic-cli-has-tty || return 0
    _MAGIC_CLI_SPIN_PID=$( (
        _magic-cli-spin-loop "$$" >/dev/null 2>&1 &
        echo $!
    ) 2>/dev/null)
    return 0
}

function _magic-cli-spin-stop() {
    [[ -n ${_MAGIC_CLI_SPIN_PID-} ]] || return 0
    kill "${_MAGIC_CLI_SPIN_PID-}" 2>/dev/null
    _MAGIC_CLI_SPIN_PID=''
    printf '\r\033[K' >/dev/tty 2>/dev/null
    return 0
}

function _magic-cli-spin-loop() {
    local parent=$1 frames='-\|/' i=0
    exec 3>/dev/tty || return 0
    while :; do
        # 父 shell 没了就自己退出，避免异常退出后留一个永远转的孤儿进程
        kill -0 "$parent" 2>/dev/null || return 0
        printf '\r\033[90m  %s thinking...\033[0m' "${frames:$((i % 4)):1}" >&3
        i=$((i + 1))
        sleep 0.1
    done
}
