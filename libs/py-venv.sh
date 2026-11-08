#!/bin/bash
#
# Python 虚拟环境管理（bash / zsh 共用）
#
# 设计要点（踩过的坑，改之前先读）：
#   1. 4 个命令 + chpwd 自动切换**不依赖 uv**，所以绝不能把它们关在
#      「uv 是否存在于某个路径」的门后面 —— 之前那道
#      `[[ ! -f $HOME/.local/bin/uv ]] && return 0` 让装了 Homebrew uv 的机器上
#      整条链路静默失效（函数根本没定义）。uv 只影响「shell 补全」这一件事。
#   2. uv 的补全脚本有 7064 行 / 569KB，`eval "$(uv generate-shell-completion zsh)"`
#      实测要 80ms（快赶上整套配置的启动时间）。而 Homebrew / 官方安装器本来就把
#      `_uv` / `_uvx` 放进了 fpath 的 site-functions（本机：
#      /opt/homebrew/share/zsh/site-functions/_uv），compinit 之后是 autoload 状态，
#      第一次按 Tab 才加载 —— 所以启动期正确的做法是什么都不做，只注册一个包装
#      函数；只有非标准安装（_uv 不在 fpath）才走自己生成 + 缓存的兜底路径。
#   3. 本文件会被 bashrc.sh 也 source，所以文件顶层只允许 bash 能解析的语法；
#      zsh 专属写法（autoload / compdef / $commands / $words）全部收在
#      try-init-uv 与 _py-venv-* 函数体内，且只在 zsh 下被调用。

# ---------------------------------------------------------------- 常用命令

# 环境名会被直接拼进路径，所有涉及路径的命令都得先过这一关。
# 只拒绝「会逃出 $PYTHON_VENVS_HOME」的写法，不做更严的限制。
function _py-venv-bad-name() {
    [[ $1 == */* || $1 == . || $1 == .. ]]
}

# mk-venv <version> <name>：在 $PYTHON_VENVS_HOME 下建一个独立环境
function mk-venv() {
    if [[ $# -lt 2 ]]; then
        echo "Usage: mk-venv <version> <name>"
        return 1
    fi
    local version=$1 name=$2
    if _py-venv-bad-name "$name"; then
        echo "mk-venv: 名字不能包含 /、也不能是 . 或 ..（得到 '$name'）"
        return 1
    fi
    if [[ -d $PYTHON_VENVS_HOME/$name ]]; then
        echo "Virtualenv $name already exists"
        return 1
    fi
    if ! command -v uv >/dev/null 2>&1; then
        echo "mk-venv: 找不到 uv 命令"
        return 127
    fi
    mkdir -p "$PYTHON_VENVS_HOME"
    uv venv --no-project -p "$version" "$PYTHON_VENVS_HOME/$name"
}

# ls-venv：列出所有环境及其 Python 版本
function ls-venv() {
    [[ -d $PYTHON_VENVS_HOME ]] || return 0
    # venv 是扁平结构（$PYTHON_VENVS_HOME/<name>/pyvenv.cfg），不加 -maxdepth 会递归
    # 遍历每个环境的 site-packages：实测 2.4 万个文件 / 251ms，加了是 3ms。
    find "$PYTHON_VENVS_HOME" -maxdepth 2 -name pyvenv.cfg -exec grep -H 'version' {} \; \
        | sed -E 's/.*\/(.*)\/pyvenv.cfg:version_info = (.*)/\1 -> \2/'
}

# workon [name]：不带参数时激活当前目录的 .venv
function workon() {
    if [[ -z $1 ]]; then
        if [[ -d .venv ]]; then
            source .venv/bin/activate
        else
            echo "Usage: workon <name>"
            return 1
        fi
    elif _py-venv-bad-name "$1"; then
        echo "workon: 名字不能包含 /、也不能是 . 或 ..（得到 '$1'）"
        return 1
    elif [[ -f $PYTHON_VENVS_HOME/$1/bin/activate ]]; then
        source "$PYTHON_VENVS_HOME/$1/bin/activate"
    else
        echo "workon: virtualenv $1 not found in $PYTHON_VENVS_HOME"
        return 1
    fi
}

function rm-venv() {
    if [[ -z $1 ]]; then
        echo "Usage: rm-venv <name>"
        return 1
    fi
    if _py-venv-bad-name "$1"; then
        echo "rm-venv: 名字不能包含 /、也不能是 . 或 ..（得到 '$1'）"
        return 1
    fi
    if [[ -d $PYTHON_VENVS_HOME/$1 ]]; then
        rm -r "$PYTHON_VENVS_HOME/$1"
    else
        echo "Virtualenv $1 not exists"
        return 1
    fi
}

# 当进入一个 Git 目录后，如果 virtualenvs 中存在同名的 virtualenv, 自动切换
# 到对应的 virtualenv 环境（仅 zsh 注册为 chpwd hook；bash 需手动 workon）
#
# 每次 cd 都会跑，所以只允许一次子进程：一次 `git rev-parse` 同时问两个问题
# （普通仓库输出一行、submodule 输出两行），basename 全部改用参数展开。
# 老写法是 2 × git rev-parse + 2 × basename ≈ 35ms/cd，且在非 git 目录也要付。
function py-venv-auto() {
    # 先沿目录树找 .git（纯内建，几乎不花钱）：一路都没找到就没必要 spawn git。
    # cd 到普通目录是最常见的情况，这笔钱不该每次 cd 都付。
    local d=$PWD has_git=0
    while :; do
        [[ -e $d/.git ]] && { has_git=1; break; }
        [[ $d == / || -z $d ]] && break
        d=${d%/*}
    done

    local roots='' prj_name='' super_name=''
    if (( has_git )); then
        roots=$(git rev-parse --show-toplevel --show-superproject-working-tree 2>/dev/null)
        if [[ $roots == *$'\n'* ]]; then
            super_name=${roots#*$'\n'}
        fi
        prj_name=${roots%%$'\n'*}
        prj_name=${prj_name##*/}
        [[ -n $super_name ]] && prj_name=${super_name##*/}
    fi
    local venv_name=''
    if [[ -n $VIRTUAL_ENV ]]; then
        venv_name=${VIRTUAL_ENV##*/}
    fi

    if [[ -n $CD_PY_VENV && $prj_name != $CD_PY_VENV ]]; then
        if [[ -n $venv_name ]]; then
            deactivate
        fi
        unset CD_PY_VENV
        unset venv_name
    fi

    if [[ "$prj_name" != "" && "$prj_name" != "$venv_name" ]]; then
        if [[ -n $venv_name ]]; then
            deactivate
        fi
        # Virtualenv exists in $PYTHON_VENVS_HOME as dir
        if [[ -d $PYTHON_VENVS_HOME/$prj_name ]]; then
            workon "$prj_name"
            export CD_PY_VENV=$prj_name
        fi
    fi
}

# ------------------------------------------------------------ 启动期初始化
#
# 只做「注册」，不做探测：不 spawn 子进程（mkdir 只在目录缺失时才执行）。

function try-init-uv() {
    [[ -d $PYTHON_VENVS_HOME ]] || mkdir -p "$PYTHON_VENVS_HOME"

    # uv 装在 ~/.local/bin 的老机器也照顾到。只认「那里真的有 uv」这一种情况：
    # 无条件前插会改变整台机器的命令解析顺序（本机 ~/.local/bin 里有 ffmpeg /
    # yt-dlp 等，且本来不在 PATH 里），这属于超出本函数职责的全局行为变更。
    [[ -x $HOME/.local/bin/uv ]] && add-to-path "$HOME/.local/bin" prefix

    # zsh 专属：chpwd 自动切换 + 补全注册（bash 没有 chpwd hook，跳过）
    if [[ -n ${ZSH_VERSION-} ]]; then
        autoload -U add-zsh-hook
        # add-zsh-hook 自己会去重，不需要（也不能）自己判断：
        # `(( ! ${chpwd_functions[(I)x]} ))` 在 chpwd_functions 尚未定义时展开成空串，
        # 变成 `(( ! ))` → "bad math expression"，于是 hook 压根没注册上
        # （只有 hhb / veeva 主题会提前定义它，换 embedded/hhb-ys 主题就静默失效）。
        add-zsh-hook chpwd py-venv-auto
        _py-venv-init-completion
    fi

    return 0
}

# ------------------------------------------------- zsh 补全（内部实现）

# compdef 由 compinit 定义；没跑过 compinit 就别碰补全
function _py-venv-init-completion() {
    (( $+functions[compdef] )) || return 0

    _list_venvs() {
        local -a names=(${(f)"$(ls-venv | awk '{print $1}')"})
        _describe 'all virtualenvs' names
    }
    compdef _list_venvs workon rm-venv

    # uv 补全：**不生成任何东西**。Homebrew 和官方安装器都会把 `_uv` 放进
    # fpath 的 site-functions（本机是 /opt/homebrew/share/zsh/site-functions/_uv），
    # compinit 之后它是 autoload 状态，第一次按 Tab 才加载——启动期 0ms。
    # 所以这里只注册包装函数，真正的兜底见下面的惰性前门。
    (( $+commands[uv] )) || return 0
    compdef _uv_run_mod uv
}

# uv 补全的入口。注意：**不能**在这里 unset 自己 —— compdef 在 _comps[uv]
# 里记的是函数名，删掉后第二次按 Tab 就找不到补全函数了。whence 是内置命令，
# 重复判断的代价可以忽略。
function _uv_run_mod() {
    if ! whence -w _uv >/dev/null 2>&1; then
        # 非标准安装（比如单文件二进制）才会走到这里：自己生成一份缓存脚本
        _py-venv-load-uv-completion || {
            _message 'uv completion not available'
            return 1
        }
    fi
    _py-venv-uv-dispatch "$@"
}

# 真正的分派逻辑（uv 官方补全不处理 `uv run <file>`，见 astral-sh/uv#8432）
function _py-venv-uv-dispatch() {
    if [[ $words[2] == run && $words[CURRENT] != -* ]]; then
        _arguments '*:filename:_files'
    else
        _uv "$@"
    fi
}

# 兜底：_uv 不在 fpath 时，把 uv 的官方补全缓存到 ~/.cache 再加载。
# 已知限制：这样只补出 uv，uvx 仍没有补全（标准安装下 _uvx 也在 site-functions 里）。
# 只有第一次按 Tab 会生成，之后直接读文件（不做 zcompile：这条路径极少走到，
# 少一层复杂度比省几毫秒更重要）。
function _py-venv-load-uv-completion() {
    local cache_dir=${XDG_CACHE_HOME:-$HOME/.cache}
    local cache=$cache_dir/uv-completion.zsh
    local bin=${commands[uv]-}

    if [[ -z $bin ]]; then
        return 1
    fi
    # 缓存缺失、或 uv 升级过（二进制比缓存新）→ 重新生成
    if [[ ! -f $cache || $cache -ot $bin ]]; then
        mkdir -p "$cache_dir"
        # 生成过程中被 Ctrl-C / 被杀会留下锁目录，不清掉的话兜底路径永久失效。
        # 注意：这里不能用 zsh 的 glob 修饰符 `(Nmh+1)` —— 本文件也被 bash source，
        # 而 bash 在定义函数时就会解析函数体，那种写法会直接是语法错误。
        if [[ -d $cache.lock && -n $(find "$cache.lock" -maxdepth 0 -mmin +60 2>/dev/null) ]]; then
            rm -rf "$cache.lock"
        fi
        if mkdir "$cache.lock" 2>/dev/null; then
            local tmp=$cache.tmp.$$
            # 写临时文件再 rename：否则并发的 shell 会 source 到一个半截脚本
            if uv generate-shell-completion zsh >|"$tmp" 2>/dev/null; then
                mv -f "$tmp" "$cache"
            else
                rm -f "$tmp"
            fi
            rm -rf "$cache.lock"
        fi
    fi
    [[ -f $cache ]] || return 1
    source "$cache"
}
