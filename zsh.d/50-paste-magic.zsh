# URL 自动加引号：手打或粘贴含 ? = & 的 URL 时不用手动加引号
#
# zsh 5.9 自带两个 widget，不需要 omz 那套 bracketed-paste-magic 兼容层：
#   url-quote-magic         —— 手打时（绑定到 self-insert）
#   bracketed-paste-url-magic —— 粘贴时（包装内置 bracketed-paste，仅当粘贴内容以 URL 开头）
#
# 想关掉：export DISABLE_MAGIC_FUNCTIONS=true

[[ "$DISABLE_MAGIC_FUNCTIONS" == true ]] && return 0

autoload -Uz url-quote-magic bracketed-paste-url-magic
zle -N self-insert url-quote-magic
zle -N bracketed-paste bracketed-paste-url-magic
