# 颜色变量与 ls 配色（源自 oh-my-zsh/lib/theme-and-appearance.zsh）
#
# autoload colors 是 zsh 自带函数（/usr/share/zsh/5.9/functions/colors），
# 提供 $fg[...] / $bg[...] / $reset_color —— hhb 等主题都靠它。

autoload -Uz colors && colors
setopt prompt_subst

# diff 也上个色（macOS 自带 / BSD diff 不支持时会自动跳过）
if command diff --color /dev/null{,} &>/dev/null; then
    function diff { command diff --color "$@" }
fi

[[ "$DISABLE_LS_COLORS" == true ]] && return 0

# BSD ls 的配色表
export LSCOLORS="Gxfxcxdxbxegedabagacad"

# GNU ls / 补全用的 LS_COLORS
if [[ -z "$LS_COLORS" ]]; then
    if (( $+commands[dircolors] )); then
        if [[ -f "$HOME/.dircolors" ]]; then
            source <(dircolors -b "$HOME/.dircolors")
        else
            source <(dircolors -b)
        fi
    else
        export LS_COLORS="di=1;36:ln=35:so=32:pi=33:ex=31:bd=34;46:cd=34;43:su=30;41:sg=30;46:tw=30;42:ow=30;43"
    fi
fi

# 按平台给 ls 加彩色开关（探测参数支持，避免 BSD/GNU 差异）
function _try-ls-args {
    command "$1" "${@[2,-1]}" /dev/null &>/dev/null
}

case "$OSTYPE" in
    darwin*|freebsd*)
        _try-ls-args ls -G && alias ls='ls -G'
        ;;
    *)
        if _try-ls-args ls --color; then
            alias ls='ls --color=tty'
        elif _try-ls-args ls -G; then
            alias ls='ls -G'
        fi
        ;;
esac

unfunction _try-ls-args

# 目录跳转那套（l/ll/la/md/rd/.../d/auto_cd）按你的要求弃用了，
# 只留下历史里最常用的 ls 别名（ll 用过 84 次）。
alias ll='ls -lh'
alias la='ls -lAh'
