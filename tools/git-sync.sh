#!/bin/bash -e
# vim: ft=bash

function log() {
    echo "$(date "+%m-%d %H:%M:%S") >> $@" >&2
}

function debug() {
    if [[ -n $DEBUG ]]; then
        log "[DEBUG]" $@
    fi
}

function warn() {
    local RED='\033[0;31m'
    local NC='\033[0m' # No Color
    echo -ne $RED
    log $@
    echo -ne $NC
}

function is_conflict() {
    local fs=$(git ls-files -u | wc -l)
    if [[ $fs -gt 0 ]]; then
        return 0
    else
        return 1
    fi
}

debug "Script start: $1"
if [[ -n $1 ]]; then
    cd $1
fi

if is_conflict; then
    warn "The repository is in conflict state, abort!"
    exit
fi

debug "Commit local"
if [[ $(git status --porcelain | wc -l) -gt 0 ]]; then
    git add .
    git commit -qm "Updated on $(hostname)"
else
    log "No local new commit"
fi

debug "Fetch remote"
git fetch -q origin

debug "Merge remote"
if git merge-base --is-ancestor origin/master HEAD; then
    log "Local file is update to date"
elif git merge-base --is-ancestor HEAD origin/master; then
    log "Process a fast-forward."
    git merge --ff-only > /dev/null
else
    log "Process a merge"
    if git merge > /dev/null; then
        log "Merge succeeded."
    else
        warn "Conflict found"
        exit
    fi
fi
debug

debug "Update remote"
if ! git merge-base --is-ancestor origin/master HEAD; then
    warn "Something wrong?"
    exit 1
fi
if [[ "$(git rev-parse origin/master)" == "$(git rev-parse HEAD)" ]]; then
    log "Remote file is update to date"
else
    log "Push to remote"
    git push
fi
