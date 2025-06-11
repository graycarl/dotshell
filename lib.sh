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

function add-to-path() {
    # usage: add-to-path <path> prefix|suffix
    if [[ ":$PATH:" == *":$1:"* ]]; then
        return 0
    fi
    if [[ -d $1 ]]; then
        if [[ $2 == "prefix" ]]; then
            export PATH="$1:$PATH"
        elif [[ $2 == "suffix" ]]; then
            export PATH="$PATH:$1"
        else
            echo "Usage: add-to-path <path> prefix|suffix"
            return 1
        fi
    else
        echo "$1 is not a directory"
        return 1
    fi
}

# Put xxx.session in CONFIG_DIR
# eg.
# cat xxx.session
# ENV VIM_COPILOT=1
# editor ~/Sources/ChinaSFA
# debug ~/Sources/ChinaSFA
TMUX_INIT_CONFIG=$HOME/.config/tmux-init
function tmux-init() {
    # set -e
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
    # set -e
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

# 当进入一个 Git 目录后，如果 virtualenvs 中存在同名的 virtualenv, 自动切换
# 到对应的 virtualenv 环境
function py-venv-auto() {
    local prj_name=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
    local super_name=$(basename "$(git rev-parse --show-superproject-working-tree 2>/dev/null)")
    if [[ -n $super_name ]]; then
        prj_name=$super_name
    fi
    if [[ -n $VIRTUAL_ENV ]]; then
        local venv_name=$(basename $VIRTUAL_ENV)
    fi

    if [[ -n $CD_PY_VENV && $prj_name != $CD_PY_VENV ]]; then
        if [[ -n $venv_name ]]; then
            deactivate
        fi
        unset CD_PY_VENV
        unset venv_name
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
    if [[ ! -f $HOME/.local/bin/uv ]]; then
        return 0
    fi
    add-to-path $HOME/.local/bin prefix
    eval "$(uv generate-shell-completion zsh)"
    # fix uv completion, see: https://github.com/astral-sh/uv/issues/8432#issuecomment-2453494736
    _uv_run_mod() {
        if [[ "$words[2]" == "run" && "$words[CURRENT]" != -* ]]; then
            _arguments '*:filename:_files'
        else
            _uv "$@"
        fi
    }
    compdef _uv_run_mod uv

    mkdir -p $PYTHON_VENVS_HOME 
    function mk-venv() {
        if [[ -z $1 ]]; then
            echo "Usage: mk-venv <version> <name>"
            return 1
        fi
        if [[ -d $PYTHON_VENVS_HOME/$1 ]]; then
            echo "Virtualenv $1 already exists"
            return 1
        fi
        uv venv --no-project -p $1 $PYTHON_VENVS_HOME/$2
        # source $PYTHON_VENVS_HOME/$1/bin/activate
    }
    function ls-venv() {
        # find pyvenv.cfg in subdirs in $PYTHON_VENVS_HOME
        # print the dir name and version info from pyvenv.cfg
        find $PYTHON_VENVS_HOME -name pyvenv.cfg -exec grep -H 'version' {} \; \
            | sed -E 's/.*\/(.*)\/pyvenv.cfg:version_info = (.*)/\1 -> \2/'
    }
    function workon() {
        if [[ -z $1 ]]; then
            if [[ -d .venv ]]; then
                source .venv/bin/activate
            else
                echo "Usage: workon <name>"
                return 1
            fi
        else
            source $PYTHON_VENVS_HOME/$1/bin/activate
        fi
    }
    function rm-venv() {
        if [[ -z $1 ]]; then
            echo "Usage: rm-venv <name>"
            return 1
        fi
        if [[ -d $PYTHON_VENVS_HOME/$1 ]]; then
            rm -r $PYTHON_VENVS_HOME/$1
        else
            echo "Virtualenv $1 not exists"
            return 1
        fi
    }

    _list_venvs() {
        local names=($(ls-venv | awk '{print $1}'))
        _describe 'all virtualenvs' names
    }
    compdef _list_venvs workon
    compdef _list_venvs rm-venv

    # 进入目录时自动切换 virtualenv
    autoload -U add-zsh-hook
    add-zsh-hook chpwd py-venv-auto
}

# Unlock keychain when ssh to mac
function unlock-keychain() {
    security unlock-keychain $HOME/Library/Keychains/login.keychain
}
