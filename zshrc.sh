export DOTSHELL=$HOME/.shell
export ZSH=$DOTSHELL/oh-my-zsh

source $DOTSHELL/base.sh

plugins=(git)
source $DOTSHELL/omzrc.sh
source $ZSH/oh-my-zsh.sh

source $DOTSHELL/lib.sh
source $HOME/.shlocal
