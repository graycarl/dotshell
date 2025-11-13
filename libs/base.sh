#!/bin/bash

function add-to-path() {
    # usage: add-to-path <path> prefix|suffix
    if [[ ":$PATH:" == *":$1:"* ]]; then
        return 0
    fi
    if [[ -d $1 ]]; then
        if [[ $2 == "prefix" ]]; then
            export PATH="$1:$PATH"
        elif [[ $2 == "suffix" ]]; then
            export PATH="$PATH:$1"
        else
            echo "Usage: add-to-path <path> prefix|suffix"
            return 1
        fi
    else
        echo "$1 is not a directory"
        return 1
    fi
}

