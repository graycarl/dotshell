YS_VCS_PROMPT_SUFFIX="%{$reset_color%}"
YS_VCS_PROMPT_DIRTY=" %{$fg[red]%}x"
YS_VCS_PROMPT_CLEAN=" %{$fg[green]%}o"

# Git info
local git_info='$(git_prompt_info)'

# hide git prefix
ZSH_THEME_GIT_PROMPT_PREFIX=" %{$fg[cyan]%}"

ZSH_THEME_GIT_PROMPT_SUFFIX="$YS_VCS_PROMPT_SUFFIX"
ZSH_THEME_GIT_PROMPT_DIRTY="$YS_VCS_PROMPT_DIRTY"
ZSH_THEME_GIT_PROMPT_CLEAN="$YS_VCS_PROMPT_CLEAN"

# Python virtualenv
local venv_info='$(virtualenv_info)'
virtualenv_info() {
    [ $VIRTUAL_ENV ] && echo -n ' ('`basename $VIRTUAL_ENV`')'
}

local exit_code="%(?,, C:%{$fg[red]%}%?%{$reset_color%})"

# Prompt format:
#
# PRIVILEGES USER @ MACHINE in DIRECTORY on git:BRANCH STATE [TIME] C:LAST_EXIT_CODE
# $ COMMAND
#
# For example:
#
# % ys @ ys-mbp in ~/.oh-my-zsh on git:master x [21:47:42] C:0
# $
PROMPT="\
%{$terminfo[bold]$fg[blue]%}#%{$reset_color%} \
%{$fg[green]%}%m\
$exit_code\
%{$terminfo[bold]$fg[red]%} $ %{$reset_color%}"

RPROMPT="\
%{$fg[green]%}%~\
%{$fg[magenta]%}$venv_info%{$reset_color%}\
%{$fg[cyan]%} %@%{$reset_color%}"
