# 键盘绑定（emacs keymap）
#
# 从 oh-my-zsh/lib/key-bindings.zsh（MIT）精简而来：只保留 emacs keymap —— 本仓库
# 从未 bindkey -v，原来的 -M viins / -M vicmd 三份重复绑定是死代码。
#
# 要点：↑/↓ 按已输入前缀搜历史、Ctrl-R 增量搜索、Ctrl-X Ctrl-E 用 $EDITOR 编辑命令行、
#      Home/End/PgUp/PgDn/Shift-Tab/Delete 按 terminfo 补齐、Ctrl-←/→ 按词移动。

bindkey -e

# 终端特殊键：terminfo 里有条目才绑（不同终端编码不同，如 khome 可能是 ^[OH 或 ^[[H）
for _k in khome:beginning-of-line kend:end-of-line \
          kpp:up-line-or-history knp:down-line-or-history \
          kdch1:delete-char kcbt:reverse-menu-complete; do
    [[ -n ${terminfo[${_k%%:*}]} ]] && bindkey "${terminfo[${_k%%:*}]}" ${_k#*:}
done
unset _k

# ↑/↓：按已输入的前缀搜索历史
autoload -Uz up-line-or-beginning-search down-line-or-beginning-search
zle -N up-line-or-beginning-search
zle -N down-line-or-beginning-search
bindkey '^[[A' up-line-or-beginning-search
bindkey '^[[B' down-line-or-beginning-search
[[ -n ${terminfo[kcuu1]} ]] && bindkey "${terminfo[kcuu1]}" up-line-or-beginning-search
[[ -n ${terminfo[kcud1]} ]] && bindkey "${terminfo[kcud1]}" down-line-or-beginning-search

# Ctrl-Delete / Ctrl-← / Ctrl-→
bindkey '^[[3;5~' kill-word
bindkey '^[[1;5C' forward-word
bindkey '^[[1;5D' backward-word

bindkey '^r' history-incremental-search-backward     # 增量搜历史
bindkey ' ' magic-space                              # 空格不做历史展开
bindkey '\ew' kill-region                            # Esc-w：从光标杀到 mark
bindkey -s '\el' 'ls\n'                              # Esc-l：直接执行 ls
bindkey '^[m' copy-prev-shell-word                   # 复制上一个词

# Ctrl-X Ctrl-E：用 $EDITOR 编辑当前命令行
autoload -Uz edit-command-line
zle -N edit-command-line
bindkey '\C-x\C-e' edit-command-line
