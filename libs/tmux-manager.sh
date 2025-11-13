#!/bin/bash

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

