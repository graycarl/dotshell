function container_info {
    if [[ $TERM_PROGRAM = "vscode" ]]; then
        echo "VSCode"
    fi
    if [[ -n $VIM ]]; then
        echo "InVim"
    fi
}

setopt prompt_subst
autoload colors
colors

turquoise="$fg[cyan]"
orange="$fg[yellow]"
purple="$fg[magenta]"
hotpink="$fg[red]"
limegreen="$fg[green]"

PROMPT=$'%{$purple%}> $(container_info)%{$reset_color%} $ '
RPROMPT="%{$fg[cyan]%} %{$limegreen%}%~%{$reset_color%} %{$reset_color%}"
