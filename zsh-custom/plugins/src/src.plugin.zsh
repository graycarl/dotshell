# Copyed from plugins pj, just change some keyword

src () {
    emulate -L zsh

    cmd="cd"
    project=$1

    if [[ "open" == "$project" ]]; then
        shift
        project=$*
        cmd=_src_cd_open
    else
        project=$*
    fi

    for basedir ($LIBRARY_PATHS); do
        if [[ -d "$basedir/$project" ]]; then
            $cmd "$basedir/$project"
            return
        fi
    done

    echo "No such project '${project}'."
}

_src () {
    emulate -L zsh

    typeset -a projects
    for basedir ($LIBRARY_PATHS); do
        projects+=(${basedir}/*(/N))
    done

    compadd ${projects:t}
}
compdef _src src

_src_cd_open() {
    cd $1
    nvim "+NERDTree"
}
