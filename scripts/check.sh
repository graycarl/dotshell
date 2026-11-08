#!/usr/bin/env bash
#
# 配置自检：把「文档里承诺的东西必须真的存在」变成可执行的断言。
#
#   $ bash scripts/check.sh                # 快速检查
#   $ bash scripts/check.sh --setup        # 额外验证每个 apps/*/setup.sh 幂等且真的建了东西
#   $ bash scripts/check.sh --no-shellcheck
#
# 为什么需要它：这个仓库的失败模式是「静默降级」而不是报错 ——
#   * 函数被一道条件挡住、根本没定义（py-venv 整条链路就这样失效了很久：
#     `[[ ! -f ~/.local/bin/uv ]] && return 0`，而 uv 装在 Homebrew）；
#   * libs/ 是 bash/zsh 双载的，混进顶层 zsh 语法 → bash 里无声地少一堆函数；
#   * setup.sh 建了指向已删除文件的软链。
# 这些全都不报错，只是「你没这个功能了」。所以这里断言的是「存在性」，而不是行为。
#
# 全部检查都在沙盒 HOME 里跑（$SANDBOX/.shell 链到本仓库的内容）：
#   * 复刻真实部署形态 —— zshrc.sh / bashrc.sh 里都硬写了
#     `export DOTSHELL=$HOME/.shell`，从外部传 DOTSHELL 会被它们覆盖；
#   * 不会碰你真实的 ~/.config、~/.cache、local/shrc，CI 和本地跑的是同一套。
#
# 不做启动耗时门槛：共享 CI runner 的时间抖动比要抓的回归还大，
# 只把测出来的数字打出来供参考。

set -uo pipefail

usage() {
    cat <<'USAGE'
用法: bash scripts/check.sh [--setup] [--no-shellcheck]

  --setup          额外检查每个 apps/*/setup.sh（幂等 + 建出的软链有效 + 期望的落地物存在）
  --no-shellcheck  跳过 shellcheck（默认缺 shellcheck 视为失败，免得「没检查」被报成「通过」）
  -h, --help       显示本帮助
USAGE
}

RUN_SETUP=0
SKIP_SHELLCHECK=0
for arg in "$@"; do
    case $arg in
        --setup)         RUN_SETUP=1 ;;
        --no-shellcheck) SKIP_SHELLCHECK=1 ;;
        -h|--help)       usage; exit 0 ;;
        *) printf '未知参数：%s\n\n' "$arg" >&2; usage >&2; exit 2 ;;
    esac
done

# 解析软链，拿到仓库根（脚本被 ln -s 到 PATH 里也能用）
_self=${BASH_SOURCE[0]}
while [[ -L $_self ]]; do
    _dir=$(cd -- "$(dirname -- "$_self")" && pwd)
    _self=$(readlink "$_self")
    [[ $_self == /* ]] || _self=$_dir/$_self
done
REPO=$(cd -- "$(dirname -- "$_self")/.." && pwd)
if [[ ! -f $REPO/zshrc.sh || ! -d $REPO/libs ]]; then
    printf '无法定位仓库根目录（得到 %s）\n' "$REPO" >&2
    exit 2
fi

if [[ -t 1 ]]; then
    C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
    C_OK=''; C_BAD=''; C_DIM=''; C_OFF=''
fi

FAILED=0
ok()  { printf '  %s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
bad() {
    printf '  %s✗%s %s\n' "$C_BAD" "$C_OFF" "$*"
    FAILED=$((FAILED + 1))
}
info() { printf '  %s·%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
indent() { sed 's/^/      /'; }

# ------------------------------------------------------------ 沙盒环境

SANDBOX=$(mktemp -d) || exit 1
cleanup() { rm -rf "$SANDBOX"; }
# INT/TERM 必须自己 exit：只 cleanup 不退出的话，脚本会带着被删掉的沙盒继续往下跑，
# 打出一片假红。
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

export HOME=$SANDBOX
# 别让调用者环境里的变量改变被检查的对象（setup.sh 里有 ${DOTSHELL:-...}，
# 任何用 ${XDG_CONFIG_HOME:-...} 的地方都会绕开沙盒写到真实目录）
unset DOTSHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME ZDOTDIR GIT_DIR

# 固定 TERM：zshrc.sh 里有一道 Emacs Tramp 保护（TERM=dumb 时 unsetopt zle 后直接
# return），而 GitHub Actions 的 TERM 正是 dumb —— 不钉死的话「加载无报错」会假绿，
# 因为整份配置根本没被加载。dumb 分支本身下面单独测。
export TERM=xterm-256color

mkdir -p "$HOME/.shell"
for _p in "$REPO"/*; do
    [[ ${_p##*/} == local ]] && continue      # 机器级私有配置，与仓库无关
    ln -s "$_p" "$HOME/.shell/"
done
unset _p

# ------------------------------------------------------------ 断言工具

# 断言：退出码 0 + stderr 干净（stdout 允许有内容，通过时照样打出来）
assert_quiet() {
    local desc=$1; shift
    local outf errf rc out err
    outf=$(mktemp) || return 1
    errf=$(mktemp) || { rm -f "$outf"; return 1; }
    "$@" >"$outf" 2>"$errf"; rc=$?
    out=$(cat "$outf"); err=$(cat "$errf")
    rm -f "$outf" "$errf"
    if (( rc == 0 )) && [[ -z $err ]]; then
        ok "$desc"
        [[ -n $out ]] && printf '%s\n' "$out" | indent
        return 0
    fi
    bad "$desc"
    { [[ -n $err ]] && printf '%s\n' "$err"; [[ -n $out ]] && printf '%s\n' "$out"; } \
        | head -20 | indent
    return 1
}

# 断言：退出码 0 且 **两个流** 都为空（用于「加载配置不该有任何输出」）
assert_silent() {
    local desc=$1; shift
    local outf errf rc out err
    outf=$(mktemp) || return 1
    errf=$(mktemp) || { rm -f "$outf"; return 1; }
    "$@" >"$outf" 2>"$errf"; rc=$?
    out=$(cat "$outf"); err=$(cat "$errf")
    rm -f "$outf" "$errf"
    if (( rc == 0 )) && [[ -z $err && -z $out ]]; then
        ok "$desc"
        return 0
    fi
    bad "$desc"
    {
        [[ -n $err ]] && printf '%s\n' "$err"
        # 注意：libs/base.sh 的 add-to-path / load-shrc 用的是 echo（stdout），
        # 所以「加载期噪音」必须连 stdout 一起断言，否则这类回归根本抓不到
        [[ -n $out ]] && printf '%s\n' "$out"
    } | head -20 | indent
    return 1
}

# ------------------------------------------------------------ 加载检查

check_zsh_load() {
    zsh -f -c 'source ~/.shell/zshrc.sh'
}

check_bash_load() {
    # 走真实入口（bashrc.sh = ~/.bashrc 的链接源，它负责 export DOTSHELL）。
    # 末尾的 `:` 用来吃掉 bashrc 最后一条语句的退出码（`test -e .shlocal` 为假时是 1），
    # 真正的错误靠输出断言。
    bash -c 'source ~/.shell/bashrc.sh; :'
}

check_zsh_symbols() {
    zsh -f -c '
        source ~/.shell/zshrc.sh || exit 1
        local -a want=(add-to-path load-shrc try-init-rust try-init-neovim try-init-uv
                       mk-venv ls-venv workon rm-venv py-venv-auto
                       magic-cli worktree tmux-init tmux-clean
                       gui-notify gui-prompt unlock-keychain _uv_run_mod)
        local f missing=""
        for f in $want; do
            (( $+functions[$f] )) || missing+="$f "
        done
        # 「注册」型的东西：函数在但没挂上一样是坏的
        (( ${chpwd_functions[(I)py-venv-auto]} )) || missing+="[hook:py-venv-auto] "
        (( ${chpwd_functions[(I)steeef_chpwd]} ))  || missing+="[hook:steeef_chpwd] "
        # brew 装的 uv 会把 _uv 自动塞进 _comps[uv]，所以要断言到具体函数
        if (( $+commands[uv] )); then
            [[ ${_comps[uv]-} == _uv_run_mod ]]     || missing+="[compdef:uv→${_comps[uv]-none}] "
        fi
        (( $+_comps[workon] ))                      || missing+="[compdef:workon] "
        [[ ${aliases[grep]-} == *--color* ]]        || missing+="[alias:grep] "
        if [[ -n $missing ]]; then
            print -r -- "缺少：$missing"
            exit 1
        fi
    '
}

check_bash_symbols() {
    bash -c '
        source ~/.shell/bashrc.sh; :
        missing=""
        for f in add-to-path try-init-rust try-init-neovim \
                 mk-venv ls-venv workon rm-venv; do
            declare -F "$f" >/dev/null || missing+="$f "
        done
        if [[ -n $missing ]]; then
            echo "缺少：$missing"
            exit 1
        fi
    '
}

# TERM=dumb（Emacs Tramp）时 zshrc.sh 会 unsetopt zle 后直接 return：
# 这条路径也不能报错，而且必须是真的早退（没加载 libs）
check_tramp_early_exit() {
    TERM=dumb zsh -f -c '
        source ~/.shell/zshrc.sh || exit 1
        (( $+functions[add-to-path] )) && { print -r -- "TERM=dumb 时没有早退"; exit 1; }
        [[ ${PS1[1,1]} == \$ ]] || { print -r -- "TERM=dumb 时 PS1=${PS1}"; exit 1; }
    '
}

# ------------------------------------------------------------ 语法检查

# 注意：所有 glob 都必须带 $REPO 前缀 —— 否则从仓库外的目录调用时 glob 展不开，
# 每一项都被 `[[ -f ]] || continue` 跳过，结果「一个文件都没检查」却报 ✓。
check_syntax() {
    local f rc=0 n=0
    for f in "$REPO"/base.sh "$REPO"/lib.sh "$REPO"/bashrc.sh "$REPO"/samples.sh \
             "$REPO"/scripts/*.sh "$REPO"/tools/*.sh "$REPO"/apps/*/setup.sh; do
        [[ -f $f ]] || continue
        n=$((n + 1))
        bash -n "$f" 2>/dev/null || { echo "bash 语法错误：${f#"$REPO"/}"; rc=1; }
    done
    # libs/ 是 bash/zsh 双载的，两个解释器都得能解析
    for f in "$REPO"/libs/*.sh; do
        [[ -f $f ]] || continue
        n=$((n + 1))
        bash -n "$f" 2>/dev/null || { echo "bash 语法错误：${f#"$REPO"/}"; rc=1; }
        zsh -n "$f" 2>/dev/null || { echo "zsh 语法错误：${f#"$REPO"/}"; rc=1; }
    done
    # zsh 专有文件（zsh.d、主题、补丁）不能拿 bash 解析
    for f in "$REPO"/zshrc.sh "$REPO"/zsh.d/*.zsh \
             "$REPO"/zsh-custom/patches/*.zsh "$REPO"/zsh-custom/themes/*.zsh-theme; do
        [[ -f $f ]] || continue
        n=$((n + 1))
        zsh -n "$f" 2>/dev/null || { echo "zsh 语法错误：${f#"$REPO"/}"; rc=1; }
    done
    (( n > 0 )) || { echo "一个文件都没检查到（REPO=$REPO）"; rc=1; }
    echo "检查了 $n 个文件"
    return $rc
}

# ------------------------------------------------------------ 其它守卫

check_shellcheck() {
    if (( SKIP_SHELLCHECK )); then
        info "按 --no-shellcheck 跳过"
        return 0
    fi
    if ! command -v shellcheck >/dev/null 2>&1; then
        # 缺依赖时报绿等于把「没检查」包装成「通过」。macOS 上 shellcheck 不是自带的，
        # 想跳过请显式加 --no-shellcheck。
        echo "未安装 shellcheck（brew install shellcheck），或用 --no-shellcheck 显式跳过"
        return 1
    fi
    # libs/*.sh 是 bash/zsh 双载的：里面刻意包含 zsh 语法（$words/$commands/${(f)...}），
    # 但全部收在只在 zsh 下调用的函数体内。排掉这三个「zsh 数组/展开」相关的码，
    # 其余 error 级问题仍然要报。tools/ 暂不纳入（历史脚本有自己的风格，另开 PR 清）。
    shellcheck -s bash --severity=error \
        --exclude=SC2296,SC1087,SC2203 \
        "$REPO"/libs/*.sh "$REPO"/base.sh "$REPO"/lib.sh "$REPO"/bashrc.sh \
        "$REPO"/samples.sh "$REPO"/scripts/*.sh "$REPO"/apps/*/setup.sh
}

# 跟踪进仓库的 auth.json = 密钥泄露（模板 *.tpl 是允许的）
check_no_tracked_secrets() {
    local leaked
    if ! git -c safe.directory="$REPO" -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "跳过：$REPO 不是可用的 git 工作区"
        return 0
    fi
    leaked=$(git -c safe.directory="$REPO" -C "$REPO" ls-files | grep -E '(^|/)auth\.json$' || true)
    if [[ -n $leaked ]]; then
        echo "这些 auth.json 被跟踪了，应立即 git rm --cached 并轮换密钥："
        printf '%s\n' $leaked | indent
        return 1
    fi
    return 0
}

# 每个 apps/*/setup.sh 在干净 HOME 里连跑两次：第二次必须也成功，
# 且建出来的软链都不能指向不存在的东西
check_setup_idempotent() {
    local home=$SANDBOX/setup-home rc=0 s
    local -a want=(
        ".config/ghostty/config"
        ".config/opencode/opencode.json"
        ".pi/agent/APPEND_SYSTEM.md"
        ".pi/agent/extensions"
    )
    mkdir -p "$home"
    for s in "$REPO"/apps/*/setup.sh; do
        [[ -f $s ]] || continue
        local name=${s#"$REPO"/}
        if ! HOME=$home bash "$s" >/dev/null 2>&1; then
            echo "首次执行失败：$name"; rc=1; continue
        fi
        if ! HOME=$home bash "$s" >/dev/null 2>&1; then
            echo "第二次执行失败（不幂等）：$name"; rc=1; continue
        fi
    done
    # 「跑两次不报错」不足以说明它干了活：一个 `exit 0` 的空脚本也能通过。
    # 所以再断言最小落地物真的存在。
    local w links
    for w in $want; do
        [[ -e $home/$w ]] || { echo "缺少落地物：$w"; rc=1; }
    done
    links=$(find "$home" -type l -path "*/skills/*" 2>/dev/null | wc -l | tr -d ' ')
    (( links >= 5 )) || { echo "skills 软链只有 $links 个，明显少了"; rc=1; }

    local link
    while IFS= read -r link; do
        [[ -e $link ]] && continue          # 软链能解析 → 没问题
        echo "软链指向不存在的路径：${link#"$home"/} -> $(readlink "$link")"
        rc=1
    done < <(find "$home" -type l)
    return $rc
}

# 启动耗时只报数字，不作门槛（理由见文件头）
report_startup() {
    local t rc
    t=$( { TIMEFORMAT=%R; time (zsh -f -c 'source ~/.shell/zshrc.sh' \
            >/dev/null 2>"$SANDBOX/startup.err"); } 2>&1 ); rc=$?
    if (( rc != 0 )) || [[ -s $SANDBOX/startup.err ]]; then
        info "加载失败，耗时不具参考性"
    else
        info "沙盒里加载本仓 zsh 配置（zsh -f）：${t}s"
    fi
}

# ------------------------------------------------------------------ main

printf '%s检查仓库：%s（沙盒 HOME：%s）%s\n\n' "$C_DIM" "$REPO" "/tmp/${SANDBOX##*/}" "$C_OFF"

assert_silent "zsh 加载无任何输出"                check_zsh_load
assert_quiet  "TERM=dumb（Tramp）干净早退"        check_tramp_early_exit
assert_silent "bash 加载无任何输出"               check_bash_load
assert_quiet  "zsh 关键函数/hook/补全都在"        check_zsh_symbols
assert_quiet  "bash 关键函数都在"                 check_bash_symbols
assert_quiet  "所有 shell 文件语法正确"           check_syntax
assert_quiet  "libs/scripts/setup 无 shellcheck error" check_shellcheck
assert_quiet  "没有跟踪进仓库的 auth.json"        check_no_tracked_secrets
if (( RUN_SETUP )); then
    assert_quiet "apps/*/setup.sh 幂等、软链有效、落地物齐全" check_setup_idempotent
else
    info "跳过 setup.sh 检查（加 --setup 开启）"
fi

echo
report_startup

echo
if (( FAILED )); then
    printf '%s%d 项检查失败%s\n' "$C_BAD" "$FAILED" "$C_OFF"
    exit 1
fi
printf '%s全部通过%s\n' "$C_OK" "$C_OFF"
