# grep / egrep / fgrep 默认上色并跳过版本控制目录
# （源自 oh-my-zsh/lib/grep.zsh，去掉它那个 1 天有效的缓存文件）

function _grep-flags-available {
    command grep "$@" '' &>/dev/null <<< ''
}

if _grep-flags-available --color=auto --exclude-dir=.git; then
    alias grep='grep --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox}'
    alias egrep='grep -E --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox}'
    alias fgrep='grep -F --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox}'
elif _grep-flags-available --color=auto; then
    alias grep='grep --color=auto'
    alias egrep='grep -E --color=auto'
    alias fgrep='grep -F --color=auto'
fi

unfunction _grep-flags-available
