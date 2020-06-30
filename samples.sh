alias hbkit='PATH=$PATH:$HOME/.virtualenvs/N/bin/ command hbkit'

# virtualenvwrapper
# pip3 install --user virtualenvwrapper
# pip install --user virtualenvwrapper
PATH=$PATH:$HOME/Library/Python/3.7/bin/
PATH=$PATH:$HOME/Library/Python/2.7/bin/

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
