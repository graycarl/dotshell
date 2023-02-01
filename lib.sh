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
# editor ~/Sources/ChinaSFA
# debug ~/Sources/ChinaSFA
TMUX_INIT_CONFIG=$HOME/.config/tmux-init
function tmux-init() {
    set -e
    local name
    local wd
    for file in $TMUX_INIT_CONFIG/*.session; do
        session_name=$(basename $file .session)
        while read name wd; do
            if [[ -z ${session_created+x} ]]; then
                tmux new-session -s $session_name -n $name -c "${wd/#\~/$HOME}" -d
                session_created=1
            else
                tmux new-window -n $name -c "${wd/#\~/$HOME}"
            fi
        done < $file
        tmux select-window -t :=1
        unset session_created
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
