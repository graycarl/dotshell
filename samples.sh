function hbkit() {
    if `hash hbkit &> /dev/null`; then
        command hbkit $@
    else
        cmd="$HOME/.virtualenvs/N/bin/hbkit"
        echo Using $cmd
        $cmd $@
    fi
}
