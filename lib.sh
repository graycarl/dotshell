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

# Polipo
function polipo-start() {
    if `pgrep -q polipo`; then
        echo 'Polipo is running.'
        pgrep -fl polipo
    else
        nohup polipo socksParentProxy=localhost:1080 >> /tmp/polipo.log &
        disown
        echo "Polipo is started, Ctrl-C to detach."
        tail -f /tmp/polipo.log
    fi
}
function polipo-stop() {
    if `pkill polipo`; then
        echo 'Polipo stopped.'
    else
        echo 'Nothing found.'
    fi
}

