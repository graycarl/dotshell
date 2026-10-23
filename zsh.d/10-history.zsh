# 历史记录（源自 oh-my-zsh/lib/history.zsh，去掉 omz_history 包装）
#
# 与原来的差异：history 不再被别名到 omz_history，直接是 zsh 内置的 fc -l。

: ${HISTFILE:=$HOME/.zsh_history}
(( HISTSIZE < 50000 )) && HISTSIZE=50000
(( SAVEHIST < 10000 )) && SAVEHIST=10000

setopt extended_history        # 历史里记录时间戳
setopt hist_expire_dups_first  # 超出上限时优先删重复项
setopt hist_ignore_dups        # 不记录连续重复命令
setopt hist_ignore_space       # 空格开头的命令不入库
setopt hist_verify             # 历史展开先给我看一眼再执行

# 个人偏好（原来写在 zshrc.sh 末尾）：多窗口不共享历史，但立即落盘
unsetopt share_history
setopt inc_append_history
