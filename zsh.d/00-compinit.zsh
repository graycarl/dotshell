# 补全系统：compinit + zcompdump 缓存 + zcompile
#
# 替代 oh-my-zsh/oh-my-zsh.sh 里的 compinit / compfix / zrecompile 编排。
# 只被 zshrc.sh 加载（含 zsh 专有语法，bash 不能读）。

# 清掉可能从环境里继承来的死路径（例如已经删掉的 oh-my-zsh），并去重
fpath=(${fpath:#$DOTSHELL/oh-my-zsh/*})
fpath=(${(u)fpath})

# 把自定义补全目录加进 fpath（如果有）
[[ -d $DOTSHELL/zsh-custom/completions ]] && fpath=($DOTSHELL/zsh-custom/completions $fpath)

local _dump_dir=${XDG_CACHE_HOME:-$HOME/.cache}
local _dump=$_dump_dir/zcompdump-${HOST%%.*}-${ZSH_VERSION}
mkdir -p $_dump_dir

autoload -Uz compinit

# dump 在 24h 内 → 用 -C 跳过目录安全检查（最快，~5ms）；
# 否则做一次完整检查 -i（忽略不安全目录而不是报错，同 omz 默认）。
# 真遇到补全丢失，手动跑：compaudit | xargs chmod g-w,o-w
local -a _fresh=($_dump(Nmh-24))
if (( ${#_fresh} )); then
    compinit -C -d $_dump
else
    compinit -i -d $_dump
fi

# 编译成 .zwc 加速下次启动；带锁避免并发 zsh 同时写
if [[ ! -f $_dump.zwc || $_dump -nt $_dump.zwc ]]; then
    if mkdir "$_dump.lock" 2>/dev/null; then
        zcompile -R -U -- "$_dump.zwc" "$_dump" 2>/dev/null
        rm -rf "$_dump.lock" "$_dump.zwc.old"
    fi
fi

# 让补全候选使用与 ls 相同的配色（原 omz 在加载完主题后做这件事）
[[ -z $LS_COLORS ]] || zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"

unset _dump _dump_dir _fresh
