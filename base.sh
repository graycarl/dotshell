# Some basic common configurations for all the shell

export EDITOR=${EDITOR:-vim}

# Init rustup
if [[ -f "$HOME/.cargo/env" && -z $RUST_INITED ]]; then
    export RUST_INITED=1
    source "$HOME/.cargo/env"
fi

# Use NeoVim
if type nvim > /dev/null 2>&1; then
    alias vi='nvim'
    alias vim='nvim'
    alias view='nvim -R'
    alias vimdiff='nvim -d'
fi
