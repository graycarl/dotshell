# Some basic common configurations for all the shell

export EDITOR=${EDITOR:-vim}

# Init rustup
if [[ -f "$HOME/.cargo/env" && -z $RUST_INITED ]]; then
    export RUST_INITED=1
    source "$HOME/.cargo/env"
fi
