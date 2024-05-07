export NERD_FONT=true

if [[ $SHELL == "/bin/zsh" ]]; then
    ZSH_THEME="hhb-ys"

    plugins=(git virtualenv virtualenvwrapper)
    if [[ $TERM_PROGRAM = "vscode" ]]; then
        ZSH_THEME="embeded"
        plugins=(git virtualenv)
    fi
    if [[ -n $VIM ]]; then
        ZSH_THEME="embeded"
        plugins=(git virtualenv)
    fi
fi


export PROJECT_PATHS=(~/LibSource ~/Sources)

alias use-x86='arch -x86_64 $SHELL -l'
if [ $(arch) = "i386" ]; then
    eval "$(/usr/local/bin/brew shellenv)"
else
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

