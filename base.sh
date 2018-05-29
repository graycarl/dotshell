# Some basic common configurations for all the shell

export EDITOR=${EDITOR:-vim}

# Disable history sharing
if [[ $SHELL = "zsh" ]]; then
    unsetopt share_history
fi
