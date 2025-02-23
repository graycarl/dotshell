#!/bin/bash
# Common functions

# Tools
function notify() {
    if [[ -n $2 ]]; then
        title=$2
    else
        title="No Title"
    fi
    osascript -e "display notification \"$1\" with title \"$title\""
}

# Python
# See: https://stackoverflow.com/a/25947333
function brew-fix-venv() {
    local venv=~/.virtualenvs/$1
    # decide python version
    if [[ -e $venv/bin/python3 ]]; then
        local p=python3
    elif [[ -e $venv/bin/python2 ]]; then
        local p=python2
    fi
    echo "Backup to /tmp"
    rm -r /tmp/$1 && cp -a $venv /tmp
    echo "Remove broken links"
    find $venv -type l -delete
    echo "Recreate virtualenv using $p"
    virtualenv -p $p $venv
}

# https://github.com/pypa/virtualenv/issues/2023#issuecomment-748636276
function fix-py2-venv-for-m1() {
    pushd $1/bin
    mkdir bk; cp python bk; mv -f bk/python .;rmdir bk
    codesign -s - --preserve-metadata=identifier,entitlements,flags,runtime -f python
    popd
}

# Put xxx.session in CONFIG_DIR
# eg.
# cat xxx.session
# ENV VIM_COPILOT=1
# editor ~/Sources/ChinaSFA
# debug ~/Sources/ChinaSFA
TMUX_INIT_CONFIG=$HOME/.config/tmux-init
function tmux-init() {
    set -e
    local name
    local wd
    local session_envs
    for file in $TMUX_INIT_CONFIG/*.session; do
        session_name=$(basename $file .session)
        session_envs=$(grep -E "^ENV" $file | sed 's/ENV //')

        tmux new-session -s $session_name -n _init_ -c "${wd/#\~/$HOME}" -d
        if [[ -n $session_envs ]]; then
            echo "Creating session $session_name with envs: $(echo $session_envs | tr '\n' ' ')"
            while read env; do
                local env_name=$(echo $env | cut -d= -f1)
                local env_value=$(echo $env | cut -d= -f2)
                tmux set-environment -t $session_name $env_name $env_value
            done <<< $session_envs
        else
            echo "Creating session $session_name"
        fi

        while read name wd; do
            if [[ $name == "ENV" ]]; then
                continue
            fi
            tmux new-window -n $name -c "${wd/#\~/$HOME}"
        done < $file
        tmux kill-window -t _init_
        tmux select-window -t :=1
    done
}

function tmux-clean() {
    set -e
    for file in $TMUX_INIT_CONFIG/*.session; do
        session_name=$(basename $file .session)
        tmux kill-session -t $session_name
    done
}

# Show GUI prompt for input
function gui-prompt() {
  osascript <<EOT
    tell app "System Events"
      text returned of (display dialog "$1" default answer "$2" buttons {"OK"} default button 1 with title "$(basename $0)")
    end tell
EOT
}

# Init pyenv
# 当进入一个 Git 目录后，如果 virtualenv 中存在同名的 virtualenv, 自动在
# pyenv 中切换到对应的 virtualenv 环境
function py-venv-auto() {
    local prj_name=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
    if [[ -n $VIRTUAL_ENV ]]; then
        local venv_name=$(basename $VIRTUAL_ENV)
    fi

    if [[ -n $CD_PY_VENV && $prj_name != $CD_PY_VENV ]]; then
        if [[ -n $venv_name ]]; then
            deactivate
        fi
        unset CD_PY_VENV
    fi

    if [[ "$prj_name" != "" && "$prj_name" != "$venv_name" ]]; then
        if [[ -n $venv_name ]]; then
            deactivate
        fi
        # Virtualenv exists in $PYTHON_VENVS_HOME as dir
        if [[ -d $PYTHON_VENVS_HOME/$prj_name ]]; then
            workon $prj_name
            export CD_PY_VENV=$prj_name
        fi
    fi
}

function try-init-pyenv() {
    if command -v pyenv 1>/dev/null 2>&1; then
        eval "$(pyenv init -)"
        # pyenv-virtualenv init script will slow down every command, because
        # of the hook function. And don't get the usage of this hook function.
        # It was still working without this hook function.
        # eval "$(pyenv virtualenv-init -)"
        autoload -U add-zsh-hook
        add-zsh-hook chpwd pyenv-auto
    fi
}

function try-init-rye() {
    # RYE_HOME default to ~/.rye
    export RYE_HOME=${RYE_HOME:-$HOME/.rye}
    if [[ -d $RYE_HOME ]]; then
        source $RYE_HOME/env
    fi
}

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

function try-init-uv() {
    if ! command -v uv 1>/dev/null 2>&1; then
        return 0
    fi

    mkdir -p $PYTHON_VENVS_HOME 
    function mk-venv() {
        if [[ -z $1 ]]; then
            echo "Usage: mk-venv <name>"
            return 1
        fi
        if [[ -d $PYTHON_VENVS_HOME/$1 ]]; then
            echo "Virtualenv $1 already exists"
            return 1
        fi
        uv venv $PYTHON_VENVS_HOME/$1
        source $PYTHON_VENVS_HOME/$1/bin/activate
    }
    function ls-venv() {
        ls $PYTHON_VENVS_HOME
    }
    function workon() {
        source $PYTHON_VENVS_HOME/$1/bin/activate
    }
    autoload -U add-zsh-hook
    add-zsh-hook chpwd py-venv-auto
}

# Unlock keychain when ssh to mac
function unlock-keychain() {
    security unlock-keychain $HOME/Library/Keychains/login.keychain
}
