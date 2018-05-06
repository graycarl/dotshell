export DOTSHELL=$HOME/.shell
export ZSH=$DOTSHELL/oh-my-zsh

source $DOTSHELL/base.sh

plugins=(git)
ZSH_THEME="robbyrussell"
DISABLE_AUTO_UPDATE="true"
test -e $DOTSHELL/omzrc.sh && source $DOTSHELL/omzrc.sh
source $ZSH/oh-my-zsh.sh

source $DOTSHELL/lib.sh
test -e $HOME/.shlocal && source $HOME/.shlocal
