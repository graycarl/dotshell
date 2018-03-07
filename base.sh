# Some basic common configurations for all the shell

# EDITOR
export SVN_EDITOR='vim'
export EDITOR=vim


# Disable history sharing
if [[ $SHELL = "zsh" ]]; then
    unsetopt share_history
fi
