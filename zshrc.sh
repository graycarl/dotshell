export DOTSHELL=$HOME/.shell
export ZSH=$DOTSHELL/oh-my-zsh
export ZSH_CUSTOM=$DOTSHELL/zsh-custom

# For Emacs Tramp
# See: http://tinyurl.com/yaucgamv
[[ $TERM = "dumb" ]] && unsetopt zle && PS1='$ ' && return

plugins=(git)
ZSH_THEME="robbyrussell"
DISABLE_AUTO_UPDATE="true"

source $DOTSHELL/base.sh
source $DOTSHELL/lib.sh

load-shrc

source $ZSH/oh-my-zsh.sh

try-init-rust
try-init-neovim
try-init-uv

# I don't want to share history, that will be a mess
unsetopt share_history
# save to history immediately, not after logout
setopt inc_append_history

# aliases
alias transvideo='uv run $DOTSHELL/tools/transvideo.py --soft'
