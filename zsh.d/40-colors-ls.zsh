# 颜色变量与 ls 配色（源自 oh-my-zsh/lib/theme-and-appearance.zsh，去掉了 GNU dircolors 分支）
#
# autoload colors 是 zsh 自带函数（/usr/share/zsh/5.9/functions/colors），
# 提供 $fg[...] / $bg[...] / $reset_color —— hhb 等主题都靠它。
# 本机没有 dircolors（没装 coreutils），macOS 的 ls 吃的是 BSD 的 LSCOLORS。

autoload -Uz colors && colors

[[ "$DISABLE_LS_COLORS" == true ]] && return 0

# BSD ls 的配色表
export LSCOLORS="Gxfxcxdxbxegedabagacad"

# 按平台给 ls 加彩色开关
case "$OSTYPE" in
    darwin*|freebsd*) alias ls='ls -G' ;;
    *) command ls --color=tty /dev/null &>/dev/null && alias ls='ls --color=tty' || alias ls='ls -G' ;;
esac

# diff 也上个色（Apple diff / GNU diff 都支持 --color）
alias diff='diff --color=auto'

# 目录跳转那一套（l/ll/la/md/rd/.../d/auto_cd）按你的要求弃用了，
# 只留下历史里真在用的两个（ll 84 次 / la 41 次）。
alias ll='ls -lh'
alias la='ls -lAh'
