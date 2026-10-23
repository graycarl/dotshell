# 粘贴保护 + URL 自动加引号（源自 oh-my-zsh/lib/misc.zsh 的 magic 部分）
#
# url-quote-magic   : 粘贴/输入含 ? = & 的 URL 时自动加引号，不用手打
# bracketed-paste-magic : 粘贴内容按「字面量」插入，不会被当成按键逐字解释
#
# 想关掉：export DISABLE_MAGIC_FUNCTIONS=true

[[ "$DISABLE_MAGIC_FUNCTIONS" == true ]] && return 0

for _d in $fpath; do
    if [[ -e "$_d/url-quote-magic" ]]; then
        autoload -Uz bracketed-paste-magic
        zle -N bracketed-paste bracketed-paste-magic
        autoload -Uz url-quote-magic
        zle -N self-insert url-quote-magic
        break
    fi
done

unset _d
