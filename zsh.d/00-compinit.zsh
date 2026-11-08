# 补全系统：compinit + zcompdump 缓存 + zcompile
#
# 替代 oh-my-zsh/oh-my-zsh.sh 里的 compinit / compfix / zrecompile 编排。
# 只被 zshrc.sh 加载（含 zsh 专有语法，bash 不能读）。

# 把自定义补全目录加进 fpath（如果有）
[[ -d $DOTSHELL/zsh-custom/completions ]] && fpath=($DOTSHELL/zsh-custom/completions $fpath)

local _dump_dir=${XDG_CACHE_HOME:-$HOME/.cache}
local _dump=$_dump_dir/zcompdump-${HOST%%.*}-${ZSH_VERSION}
# 用独立的 stamp 文件记「上次完整安全检查的时间」，别拿 dump 的 mtime 当日期：
# compinit 在内容没变化时不会重写 dump（先写临时文件再比对，相同就丢弃），
# 所以 dump 的 mtime 会永远停在第一次生成那一刻。`(Nmh-24)` 是「24 小时内修改过」，
# 于是只有生成后的头 24 小时能走 -C 快路径，之后永远走完整检查
# （实测白跑 compaudit 12ms/次，本机就是这种状态）。
local _stamp=$_dump.stamp
mkdir -p $_dump_dir

autoload -Uz compinit

# 24h 内检查过 → 用 -C 跳过目录安全检查（最快，~5ms）；
# 否则做一次完整检查 -i（忽略不安全目录而不是报错，同 omz 默认）。
# 真遇到补全丢失，手动跑：compaudit | xargs chmod g-w,o-w
local -a _fresh=($_stamp(Nmh-24))
if (( ${#_fresh} )) && [[ -f $_dump ]]; then
    compinit -C -d $_dump
elif compinit -i -d $_dump; then
    # 只在完整检查成功后才记时间：dump 不可写之类的失败不能被 stamp 掩盖。
    # 用内置重定向写空文件，不 spawn 子进程（别用 touch）。
    : > $_stamp
fi

# 编译成 .zwc 加速下次启动；带锁避免并发 zsh 同时写
if [[ ! -f $_dump.zwc || $_dump -nt $_dump.zwc ]]; then
    if mkdir "$_dump.lock" 2>/dev/null; then
        zcompile -R -U -- "$_dump.zwc" "$_dump" 2>/dev/null
        rm -rf "$_dump.lock" "$_dump.zwc.old"
    fi
fi

unset _dump _dump_dir _stamp _fresh
