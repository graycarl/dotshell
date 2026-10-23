#!/bin/bash

# Ghostty theme helper
#
# usage:
#   ghostty-theme                      # show current theme line
#   ghostty-theme <name>               # set a single theme
#   ghostty-theme <light> <dark>       # set light/dark pair (follows system appearance)
#   ghostty-theme 'light:"A",dark:"B"' # raw value passthrough
#   ghostty-theme -p                   # pick from the light/dark presets
#   ghostty-theme -p <preset>          # apply a preset directly (gruvbox|kanagawa|onenord|catppuccin)
#   ghostty-theme -l [pattern]         # list all builtin ghostty themes
#   ghostty-theme -P                   # full TUI preview of every builtin theme
#   ghostty-theme -r                   # show current theme + the live resolved colors
#
# Nothing downstream needs a matching Neovim colorscheme any more: Neovim
# (~/.vim/plugin/ghostty_theme.lua) and tmux (tools/ghostty-tmux-theme.py) both
# derive their colours from the active theme's own background/foreground/palette,
# so any builtin, user or single-theme selection works. The presets below are
# just shortcuts for the pairs that also ship a curated Neovim colorscheme.
#
# After changing the theme, press Cmd+Shift+, in Ghostty to reload.

# allow callers/tests to point at another config file
GHOSTTY_CONFIG=${GHOSTTY_CONFIG:-$DOTSHELL/apps/ghostty/config}
GHOSTTY_BIN=${GHOSTTY_BIN:-/Applications/Ghostty.app/Contents/MacOS/ghostty}

# preset<TAB>light theme<TAB>dark theme
GHOSTTY_THEME_PRESETS=$(
    printf 'gruvbox\tGruvbox Light\tGruvbox Dark\n'
    printf 'kanagawa\tKanagawa Lotus\tKanagawa Wave\n'
    printf 'onenord\tOnenord Light\tOnenord\n'
    printf 'catppuccin\tCatppuccin Latte\tCatppuccin Mocha\n'
)

function ghostty-theme() {
    local config=$GHOSTTY_CONFIG
    local bin=$GHOSTTY_BIN

    if [[ ! -f $config ]]; then
        echo "Error: config not found: $config" >&2
        return 1
    fi

    case $1 in
        "")
            grep -E '^theme[[:space:]]*=' "$config" || echo "theme not set in $config"
            return 0
            ;;
        -l|--list)
            [[ ! -x $bin ]] && { echo "Error: ghostty not found: $bin" >&2; return 1; }
            if [[ -n $2 ]]; then
                "$bin" +list-themes --plain | grep -i -- "$2"
            else
                "$bin" +list-themes --plain
            fi
            return 0
            ;;
        -P|--preview-all)
            [[ ! -x $bin ]] && { echo "Error: ghostty not found: $bin" >&2; return 1; }
            "$bin" +list-themes
            return 0
            ;;
        -p|--preset)
            if [[ -n $2 ]]; then
                _ghostty-theme-apply-preset "$2" && return 0
                return 1
            fi
            _ghostty-theme-pick
            return
            ;;
        -r|--resolved)
            [[ ! -x $bin ]] && { echo "Error: ghostty not found: $bin" >&2; return 1; }
            grep -E '^theme[[:space:]]*=' "$config"
            "$bin" +show-config | grep -E '^(background|foreground|palette)' | head -20
            return 0
            ;;
    esac

    # build the theme value
    local value
    if [[ $# -ge 2 ]]; then
        value="light:\"$1\",dark:\"$2\""
    elif [[ $1 == *:* ]]; then
        value="$1"   # raw passthrough, e.g. 'light:"A",dark:"B"'
    else
        value="\"$1\""
    fi

    _ghostty-theme-write "$value"
}

# Write a theme value into the config, keeping a single active `theme =` line.
function _ghostty-theme-write() {
    local value=$1
    local config=$GHOSTTY_CONFIG
    local bin=$GHOSTTY_BIN

    # escape sed replacement metachars (& | \)
    local escaped
    escaped=$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')

    if grep -qE '^theme[[:space:]]*=' "$config"; then
        # use | as delimiter, theme names may contain spaces and commas
        sed -i '' "s|^theme[[:space:]]*=.*|theme = $escaped|" "$config"
    else
        printf 'theme = %s\n' "$value" >> "$config"
    fi

    echo "theme -> $value"
    if [[ -x $bin ]]; then
        "$bin" +validate-config >/dev/null 2>&1 \
            || echo "warn: config validation failed, check $config" >&2
    fi
    echo "press Cmd+Shift+, in Ghostty to reload"
}

# Apply one named preset (gruvbox / kanagawa / onenord / catppuccin).
function _ghostty-theme-apply-preset() {
    local want label light dark
    want=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    while IFS=$'\t' read -r label light dark; do
        if [[ $(printf '%s' "$label" | tr '[:upper:]' '[:lower:]') == "$want" ]]; then
            _ghostty-theme-write "light:\"$light\",dark:\"$dark\""
            return 0
        fi
    done <<< "$GHOSTTY_THEME_PRESETS"
    echo "Error: unknown preset '$want'" >&2
    echo "available: $(printf '%s\n' "$GHOSTTY_THEME_PRESETS" | cut -f1 | tr '\n' ' ')" >&2
    return 1
}

# Interactive preset picker (no fzf dependency, works in bash and zsh).
function _ghostty-theme-pick() {
    local current
    current=$(grep -E '^theme[[:space:]]*=' "$GHOSTTY_CONFIG")

    local i=1 label light dark marker
    printf '\n  #  preset      light theme        dark theme\n'
    printf '  -  --------    ----------------   ----------------\n'
    while IFS=$'\t' read -r label light dark; do
        marker=' '
        if [[ -n $current && $current == *"$dark"* ]]; then
            marker='*'
        fi
        printf '%s %d) %-11s %-18s %s\n' "$marker" "$i" "$label" "$light" "$dark"
        i=$((i + 1))
    done <<< "$GHOSTTY_THEME_PRESETS"
    if [[ -n $current ]]; then
        printf '\n  current: %s\n' "${current#theme = }"
    fi

    local choice line
    printf '\n> pick [1-4 / name, q to quit]: '
    IFS= read -r choice || { echo; return 1; }

    case $choice in
        ''|q|Q|quit|exit) echo "cancelled"; return 1 ;;
        *[!0-9]*) ;;   # not a number: treat as preset name
        *)
            line=$(printf '%s\n' "$GHOSTTY_THEME_PRESETS" | sed -n "${choice}p")
            if [[ -z $line ]]; then
                echo "Error: no preset number $choice" >&2
                return 1
            fi
            _ghostty-theme-apply-preset "$(printf '%s' "$line" | cut -f1)"
            return $?
            ;;
    esac

    _ghostty-theme-apply-preset "$choice"
}
