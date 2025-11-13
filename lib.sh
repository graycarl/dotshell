#!/bin/bash

# load all the lib in libs/*.sh
for file in $DOTSHELL/libs/*.sh; do
    source $file
done

function try-init-rust() {
    if [[ -f "$HOME/.cargo/env" && -z $RUST_INITED ]]; then
        export RUST_INITED=1
        source "$HOME/.cargo/env"
    fi
}

function try-init-neovim() {
    if [[ $(basename $EDITOR) = "nvim" ]]; then
        alias vi='nvim'
        alias vim='nvim'
        alias view='nvim -R'
        alias vimdiff='nvim -d'
    fi
}

# Unlock keychain when ssh to mac
function unlock-keychain() {
    security unlock-keychain $HOME/Library/Keychains/login.keychain
}
