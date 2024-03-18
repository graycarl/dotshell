export DOTSHELL=$HOME/.shell

source $DOTSHELL/base.sh
source $DOTSHELL/lib.sh

test -e $DOTSHELL/local/shrc && source $DOTSHELL/local/shrc
test -e $HOME/.shlocal && echo 'Please move .shlocal to .shell/local/shrc'
