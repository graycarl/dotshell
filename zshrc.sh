export DOTSHELL=$HOME/.shell
export ZSH=$DOTSHELL/oh-my-zsh

# For Emacs Tramp
# See: http://tinyurl.com/yaucgamv
[[ $TERM = "dumb" ]] && unsetopt zle && PS1='$ ' && return

source $DOTSHELL/base.sh

plugins=(git)
ZSH_THEME="robbyrussell"
DISABLE_AUTO_UPDATE="true"

source $DOTSHELL/lib.sh
test -e $DOTSHELL/local/shrc && source $DOTSHELL/local/shrc
test -e $HOME/.shlocal && echo 'Please move .shlocal to .shell/local/shrc'

source $ZSH/oh-my-zsh.sh

# Use NeoVim
if [[ $(basename $EDITOR) = "nvim" ]]; then
    alias vi='nvim'
    alias vim='nvim'
    alias view='nvim -R'
    alias vimdiff='nvim -d'
fi

# I don't want to share history, that will be a mess
unsetopt share_history
# save to history immediately, not after logout
setopt inc_append_history
