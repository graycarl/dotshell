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

# Use NeoVim
if type nvim > /dev/null 2>&1; then
    alias vi='nvim'
    alias vim='nvim'
    alias view='nvim -R'
    alias vimdiff='nvim -d'
fi

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
function backup-intalled-list() {
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

# Markp: Convert markdown to presentation in html / pdf
# See: https://hub.docker.com/r/marpteam/marp-cli/
alias markp='docker run --rm --init -v $PWD:/home/marp/app/ -e LANG=$LANG marpteam/marp-cli'
