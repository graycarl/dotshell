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
if type nvim > /dev/null; then
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
    CMDS=('mas list' 'brew list' 'brew cask list' 'cd /Applications/Setapp && ls -d *.app')
    echo "Generate on $(hostname) at $(date '+%Y-%m-%d %H:%M:%S')"
    echo
    for cmd in $CMDS; do
        echo "# $cmd"
        eval $cmd
        echo
    done
}
function backup-intalled-list() {
    fn="$HOME/iCloud/Backups/InstalledApps/$(hostname).$(date +%Y-%m-%d).installedapps"
    list-installed-apps > $fn
    echo "Installed apps list saved to $fn"
}
