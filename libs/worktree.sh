#!/bin/bash

# dir on git root
WORKTREE_DIR=".worktrees"

function worktree() {
    # usage: worktree <command> <args>
    # commands:
    #   add <name> [branch] - add a worktree, optionally from a branch
    #   remove [name] - remove a worktree
    #   list - list all worktrees
    #   pick [commands args] - pick a worktree from list, run commands in that worktree, if no commands, output the path

    local git_root=$(git rev-parse --show-toplevel 2>/dev/null)
    if [[ -z $git_root ]]; then
        echo "Error: not in a git repository"
        return 1
    fi

    local worktree_dir="$git_root/$WORKTREE_DIR"

    if [[ $# -lt 1 ]]; then
        echo "Usage: worktree <command> <args>"
        return 1
    fi

    local cmd=$1
    shift

    case $cmd in
        add)
            if [[ $# -lt 1 ]]; then
                echo "Usage: worktree add <name> [branch]"
                return 1
            fi
            local name=$1
            shift
            local wt_path="$worktree_dir/$name"
            if [[ -n $1 ]]; then
                git worktree add "$wt_path" "$1"
            else
                git worktree add "$wt_path"
            fi
            ;;
        remove)
            if [[ $# -lt 1 ]]; then
                local wt_path=$(git worktree list | grep -F "$WORKTREE_DIR" | pick | awk '{print $1}')
                if [[ -z $wt_path ]]; then
                    echo "No worktree selected"
                    return 1
                fi
            else
                local name=$1
                local wt_path="$worktree_dir/$name"
                if [[ ! -d $wt_path ]]; then
                    echo "Worktree $name does not exist"
                    return 1
                fi
            fi
            git worktree remove "$wt_path"
            ;;
        list)
            git worktree list
            ;;
        pick)
            local wt_path=$(git worktree list | grep -F "$WORKTREE_DIR" | pick | awk '{print $1}')
            if [[ -z $wt_path ]]; then
                echo "No worktree selected"
                return 1
            fi
            if [[ $# -gt 0 ]]; then
                (cd "$wt_path" && "$@")
            else
                echo "$wt_path"
            fi
            ;;
        *)
            echo "Unknown command: $cmd"
            return 1
            ;;
    esac
}
