# Some basic common configurations for all the shell

export EDITOR=${EDITOR:-vim}

# Disable history sharing
if [[ $SHELL = "zsh" ]]; then
    setopt no_share_history
    unsetopt share_history
fi
