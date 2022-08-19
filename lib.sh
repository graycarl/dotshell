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

# rbenv init
function init-rbenv() {
    eval "$(rbenv init -)"
}

# Go Workspace
function init-go() {
    if which -s go > /dev/null; then
        export GOROOT=`go env GOROOT`
        export GOPATH=$HOME/gospace
        export PATH=$PATH:$GOPATH/bin
    else
        echo "Golang not found."
    fi
}

# nvm
function init-nvm() {
    export NVM_DIR="$HOME/.nvm"
    source "$(brew --prefix nvm)/nvm.sh"
}

# List software installed
function list-installed-apps() {
    CMDS=('mas list' 'brew list' 'brew cask list' 'ls -d /Applications/Setapp/*.app')
    echo "Generate on $(hostname) at $(date '+%Y-%m-%d %H:%M:%S')"
    echo
    for cmd in $CMDS; do
        echo "# $cmd"
        eval $cmd
        echo
    done
}
function backup-installed-list() {
    fn="$HOME/iCloud/Backups/InstalledApps/$(hostname).$(date +%Y-%m-%d).installedapps.txt"
    list-installed-apps > $fn
    echo "Installed apps list saved to $fn"
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

# Markp: Convert markdown to presentation in html / pdf
# See: https://hub.docker.com/r/marpteam/marp-cli/
alias markp='docker run --rm --init -v $PWD:/home/marp/app/ -e LANG=$LANG marpteam/marp-cli'
