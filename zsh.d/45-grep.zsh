# grep / egrep / fgrep 默认上色并跳过版本控制目录
#
# 原来是 omz 那套「探测 grep 支持哪些参数 + 1 天有效缓存」；本机 BSD grep 2.6
# 同时支持 --color 和 --exclude-dir（含花括号展开），探测纯属每次启动 3.5ms 的浪费。

alias grep='grep --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox}'
alias egrep='grep -E --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox}'
alias fgrep='grep -F --color=auto --exclude-dir={.bzr,CVS,.git,.hg,.svn,.idea,.tox}'
