export DOTSHELL=$HOME/.shell

source $DOTSHELL/base.sh
source $DOTSHELL/lib.sh

test -e $HOME/.shlocal && source $HOME/.shlocal
