#!/bin/bash

function gui-notify() {
    if [[ -n $2 ]]; then
        title=$2
    else
        title="No Title"
    fi
    osascript -e "display notification \"$1\" with title \"$title\""
}

# Show GUI prompt for input
function gui-prompt() {
  osascript <<EOT
    tell app "System Events"
      text returned of (display dialog "$1" default answer "$2" buttons {"OK"} default button 1 with title "$(basename $0)")
    end tell
EOT
}

