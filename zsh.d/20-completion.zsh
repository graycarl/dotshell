# 补全的行为与外观（源自 oh-my-zsh/lib/completion.zsh，只保留影响手感的设置）

unsetopt menu_complete   # 不在第一次 Tab 就自动选中第一项
unsetopt flowcontrol     # 别让 Ctrl-S/Ctrl-Q 把终端冻住
setopt auto_menu         # 再按一次 Tab 才进入候选菜单
setopt complete_in_word  # 光标在词中间也能补全
setopt always_to_end     # 补全后光标跳到词尾

# 候选菜单：方向键选择；连按 Tab / 方向键循环
# 注意：menuselect keymap 由 zsh/complist 模块创建，不先加载就没法 bindkey
#      （omz 靠首次补全时 _main_complete 隐式加载，所以那行 bindkey 实际会报错）
zmodload -i zsh/complist
zstyle ':completion:*:*:*:*:*' menu select
bindkey -M menuselect '^o' accept-and-infer-next-history

zstyle ':completion:*' special-dirs true   # .. 作为候选目录
zstyle ':completion:*' list-colors ''      # 补全候选不上 ls 配色（有意为之）
zstyle '*' single-ignored show             # 唯一候选时直接显示

# cd 优先补当前目录，其次目录栈，最后 $cdpath
zstyle ':completion:*:cd:*' tag-order local-directories directory-stack path-directories

# 补全结果缓存（含 kill 进程列表），减少重复扫描
zstyle ':completion:*' use-cache yes
zstyle ':completion:*' cache-path ${XDG_CACHE_HOME:-$HOME/.cache}/zsh-completion-cache

# kill 时给进程列表上色（PID 蓝色，信号名绿色）
zstyle ':completion:*:*:kill:*:processes' list-colors '=(#b) #([0-9]#) ([0-9a-z-]#)*=01;34=0=01'
