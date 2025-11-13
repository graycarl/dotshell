#!/bin/bash

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

