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
    # 参数展开取 basename，省掉一次 fork（实测 ~2.7ms/次）；
    # 先砍掉 EDITOR 可能带的参数（如 'nvim -f'），保持和原来 `basename $EDITOR` 等价
    local _editor=${EDITOR%% *}
    if [[ ${_editor##*/} = "nvim" ]]; then
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
